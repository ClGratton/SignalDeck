// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: official OpenAI uses the Responses API; DeepSeek, Zhipu GLM,
// and custom OpenAI-compatible bases keep the broad /chat/completions path.
// The base URL comes from the server-only key store. Both transports share the
// same manual tool loop and proposal semantics.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { systemPrompt } from '@/lib/assistant/prompt';
import { listTools, executeTool, toolLabel, type ToolContext } from '@/lib/assistant/tools';
import { maxAgentSteps } from '@/lib/assistant/config';
import {
  readOpenAiResponseStream,
  type OpenAiStreamEvent,
} from '@/lib/assistant/openai-stream';
import { readSseData } from '@/lib/assistant/sse';
import type { AssistantProvider, ChatTurn, ReasoningEffort } from '@/lib/assistant/types';

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
// One assistant message in OpenAI's schema (only the fields we send back).
interface OaMessage {
  role: 'developer' | 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

type ResponseInputItem = Record<string, unknown>;

interface ResponseFunctionCall extends ResponseInputItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

function usesOfficialResponsesApi(provider: AssistantProvider, baseUrl: string): boolean {
  return provider === 'openai' && stripTrailingSlash(baseUrl) === 'https://api.openai.com/v1';
}

async function emitHttpError(
  provider: AssistantProvider,
  res: Response,
  emit: ToolContext['emit'],
): Promise<void> {
  let detail = `${provider} returned HTTP ${res.status}.`;
  try {
    const err = (await res.json()) as { error?: { message?: string } };
    if (err.error?.message) detail = `${provider}: ${err.error.message}`;
  } catch {
    /* non-JSON error body */
  }
  emit({ type: 'error', message: detail });
}

async function cancelBackgroundResponse(
  responsesUrl: string,
  responseId: string,
  apiKey: string,
): Promise<void> {
  try {
    await fetch(`${responsesUrl}/${encodeURIComponent(responseId)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* best-effort cost cleanup after an explicit operator stop */
  }
}

/** Official OpenAI path. Background streaming lets long reasoning survive a
 * dropped upstream connection; `store:false` is retained (OpenAI temporarily
 * holds the response only so it can be resumed). Every returned output item,
 * including encrypted reasoning, is replayed during the in-turn tool loop. */
async function runResponsesTurn(
  apiKey: string,
  baseUrl: string,
  model: string,
  reasoningEffort: ReasoningEffort | undefined,
  turns: ChatTurn[],
  ctx: ToolContext,
): Promise<void> {
  const emit = ctx.emit;
  const url = `${stripTrailingSlash(baseUrl)}/responses`;
  const tools = listTools().map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
  const input: ResponseInputItem[] = turns.map((t) => ({ role: t.role, content: t.content }));

  const maxIterations = maxAgentSteps();
  for (let i = 0; i < maxIterations; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions: systemPrompt(ctx.mode, ctx.approval, ctx.chatId),
        input,
        tools: tools.length > 0 ? tools : undefined,
        reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
        include: reasoningEffort ? ['reasoning.encrypted_content'] : undefined,
        background: true,
        store: false,
        stream: true,
      }),
      cache: 'no-store',
      signal: ctx.signal,
    });

    if (!res.ok || !res.body) {
      await emitHttpError('openai', res, emit);
      return;
    }

    let output: ResponseInputItem[] = [];
    let completed = false;
    let streamError: string | null = null;
    const streamResult = await readOpenAiResponseStream({
      initialResponse: res,
      responsesUrl: url,
      apiKey,
      signal: ctx.signal,
      onEvent: (rawEvent) => {
        const event = rawEvent as OpenAiStreamEvent & {
          delta?: string;
          message?: string;
          error?: { message?: string };
          response?: {
            id?: string;
            output?: ResponseInputItem[];
            error?: { message?: string };
            incomplete_details?: { reason?: string };
          };
        };
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          emit({ type: 'text', text: event.delta });
        } else if (event.type === 'response.completed') {
          output = Array.isArray(event.response?.output) ? event.response.output : [];
          completed = true;
        } else if (event.type === 'response.failed') {
          streamError =
            event.response?.error?.message ?? 'OpenAI could not complete the response.';
        } else if (event.type === 'response.incomplete') {
          const reason = event.response?.incomplete_details?.reason;
          streamError = reason
            ? `OpenAI returned an incomplete response (${reason}).`
            : 'OpenAI returned an incomplete response.';
        } else if (event.type === 'error') {
          streamError =
            event.error?.message ?? event.message ?? 'OpenAI returned a streaming error.';
        }
      },
    });

    if (streamResult.status === 'aborted') {
      if (streamResult.responseId) {
        await cancelBackgroundResponse(url, streamResult.responseId, apiKey);
      }
      return;
    }
    if (streamResult.status === 'http_error') {
      await emitHttpError('openai', streamResult.response, emit);
      return;
    }
    if (streamResult.status === 'disconnected') {
      console.warn('[assistant] OpenAI background stream could not be resumed', {
        responseId: streamResult.responseId,
        lastSequence: streamResult.lastSequence,
      });
      emit({
        type: 'error',
        message: 'OpenAI connection dropped repeatedly before the response completed.',
      });
      return;
    }

    if (streamError) {
      emit({ type: 'error', message: `openai: ${streamError}` });
      return;
    }
    if (!completed) {
      emit({ type: 'error', message: 'OpenAI stream ended before the response completed.' });
      return;
    }

    const calls = output.filter(
      (item): item is ResponseFunctionCall =>
        item.type === 'function_call' &&
        typeof item.call_id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.arguments === 'string',
    );
    // Preserve ALL output items, especially encrypted reasoning items, before
    // appending the matching function_call_output records.
    input.push(...output);
    if (calls.length === 0) return;

    for (const call of calls) {
      emit({ type: 'tool', name: call.name, label: toolLabel(call.name) });
      let toolInput: unknown = {};
      try {
        toolInput = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        /* malformed args; executeTool validates and reports */
      }
      const outcome = await executeTool(call.name, toolInput, ctx);
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: outcome.content,
      });
    }
    if (ctx.sleep) return;
  }
  emit({
    type: 'error',
    message: 'Stopped after too many steps in one turn. Ask again to continue.',
  });
}

async function runChatCompletionsTurn(
  provider: AssistantProvider,
  apiKey: string,
  baseUrl: string,
  model: string,
  reasoningEffort: ReasoningEffort | undefined,
  turns: ChatTurn[],
  ctx: ToolContext,
): Promise<void> {
  const emit = ctx.emit;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const tools = listTools().map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const messages: OaMessage[] = [
    {
      role: provider === 'openai' ? 'developer' : 'system',
      content: systemPrompt(ctx.mode, ctx.approval, ctx.chatId),
    },
    ...turns.map((t) => ({ role: t.role, content: t.content }) as OaMessage),
  ];

  const maxIterations = maxAgentSteps();
  for (let i = 0; i < maxIterations; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        ...(provider === 'openai' && reasoningEffort
          ? { reasoning_effort: reasoningEffort }
          : {}),
        stream: true,
      }),
      cache: 'no-store',
      signal: ctx.signal,
    });

    if (!res.ok || !res.body) {
      await emitHttpError(provider, res, emit);
      return;
    }

    let text = '';
    const callsByIndex = new Map<number, ToolCall>();
    await readSseData(res.body, (payload) => {
      if (payload === '[DONE]') return;
      let chunk: {
        choices?: {
          delta?: {
            content?: string;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: {
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
        }[];
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      // DeepSeek reasoner (and some OpenAI-compatible models) stream the chain
      // of thought separately — surface it as collapsible reasoning, not answer.
      const reason = delta.reasoning_content ?? delta.reasoning;
      if (reason) emit({ type: 'reasoning', text: reason });
      if (delta.content) {
        text += delta.content;
        emit({ type: 'text', text: delta.content });
      }
      // Tool calls stream in fragments keyed by index; accumulate them.
      for (const tc of delta.tool_calls ?? []) {
        const cur = callsByIndex.get(tc.index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        callsByIndex.set(tc.index, cur);
      }
    });

    const calls = [...callsByIndex.values()].filter((c) => c.name);
    if (calls.length === 0) return; // plain answer — turn complete

    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map((c) => ({
        id: c.id || `call_${c.name}`,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' },
      })),
    });

    for (const c of calls) {
      emit({ type: 'tool', name: c.name, label: toolLabel(c.name) });
      let input: unknown = {};
      try {
        input = c.arguments ? JSON.parse(c.arguments) : {};
      } catch {
        /* malformed args — executeTool validates and reports */
      }
      const outcome = await executeTool(c.name, input, ctx);
      messages.push({
        role: 'tool',
        tool_call_id: c.id || `call_${c.name}`,
        content: outcome.content,
      });
    }
    // start_timer asked to end the turn and hand the wait to the task runner.
    if (ctx.sleep) return;
  }
  emit({
    type: 'error',
    message: 'Stopped after too many steps in one turn. Ask again to continue.',
  });
}

export async function runOpenAiTurn(
  provider: AssistantProvider,
  apiKey: string,
  baseUrl: string,
  model: string,
  reasoningEffort: ReasoningEffort | undefined,
  turns: ChatTurn[],
  ctx: ToolContext,
): Promise<void> {
  if (usesOfficialResponsesApi(provider, baseUrl)) {
    return runResponsesTurn(apiKey, baseUrl, model, reasoningEffort, turns, ctx);
  }
  return runChatCompletionsTurn(
    provider,
    apiKey,
    baseUrl,
    model,
    reasoningEffort,
    turns,
    ctx,
  );
}
