// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: official OpenAI uses the Responses API; DeepSeek, Zhipu GLM,
// and custom OpenAI-compatible bases keep the broad /chat/completions path.
// The base URL comes from the server-only key store. Both transports share the
// same manual tool loop and proposal semantics.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { createHash } from 'node:crypto';
import { systemPrompt } from '@/lib/assistant/prompt';
import { listTools, executeTool, toolLabel, type ToolContext } from '@/lib/assistant/tools';
import { maxAgentSteps } from '@/lib/assistant/config';
import {
  supportsOpenAiComputerUse,
  supportsOpenAiHostedWebSearch,
} from '@/lib/assistant/models';
import {
  getPublicBrowserComputer,
  type ComputerAction,
} from '@/lib/assistant/computer';
import {
  readOpenAiResponseStream,
  type OpenAiStreamEvent,
} from '@/lib/assistant/openai-stream';
import { readSseData } from '@/lib/assistant/sse';
import { readAttachment } from '@/lib/assistant/attachments';
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

interface ResponseComputerCall extends ResponseInputItem {
  type: 'computer_call';
  call_id: string;
  actions: ComputerAction[];
}

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface WebCitation {
  title: string;
  url: string;
}

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

function usesOfficialResponsesApi(provider: AssistantProvider, baseUrl: string): boolean {
  return provider === 'openai' && stripTrailingSlash(baseUrl) === 'https://api.openai.com/v1';
}

function supportsExplicitPromptCache(model: string): boolean {
  return model === 'gpt-5.6' || model.startsWith('gpt-5.6-');
}

function promptCacheKey(model: string, chatId?: string): string {
  // Partition by chat to keep one busy agent loop below OpenAI's recommended
  // per-key traffic level without sending the raw internal chat id upstream.
  const scope = createHash('sha256')
    .update(chatId ?? 'shared')
    .digest('hex')
    .slice(0, 16);
  return `grtlabs:${model}:${scope}:v1`;
}

function responseInput(turns: ChatTurn[], explicitCache: boolean): ResponseInputItem[] {
  let breakpoint = -1;
  if (explicitCache) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user' && turns[i].content.length > 0) {
        breakpoint = i;
        break;
      }
    }
  }
  return turns.map((turn, index) => {
    if (turn.role !== 'user' || !turn.attachments?.length) {
      return index === breakpoint
        ? {
            role: turn.role,
            content: [{
              type: 'input_text',
              text: turn.content,
              prompt_cache_breakpoint: { mode: 'explicit' },
            }],
          }
        : { role: turn.role, content: turn.content };
    }
    const content: ResponseInputItem[] = [];
    if (turn.content) {
      content.push({
        type: 'input_text',
        text: turn.content,
        ...(index === breakpoint ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}),
      });
    }
    for (const ref of turn.attachments) {
      const attachment = readAttachment(ref.id);
      const dataUrl = `data:${attachment.mimeType};base64,${attachment.bytes.toString('base64')}`;
      content.push(
        attachment.kind === 'image'
          ? { type: 'input_image', image_url: dataUrl, detail: 'auto' }
          : { type: 'input_file', filename: attachment.name, file_data: dataUrl },
      );
    }
    return { role: 'user', content };
  });
}

function logResponseUsage(model: string, request: number, usage?: ResponseUsage): void {
  if (!usage) return;
  console.info('[assistant] OpenAI token usage', {
    model,
    request,
    inputTokens: usage.input_tokens ?? 0,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  });
}

function extractWebCitations(output: ResponseInputItem[]): WebCitation[] {
  const citations = new Map<string, WebCitation>();
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const content of item.content as Record<string, unknown>[]) {
      if (content.type !== 'output_text' || !Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations as Record<string, unknown>[]) {
        if (
          annotation.type !== 'url_citation' ||
          typeof annotation.url !== 'string' ||
          !/^https?:\/\//i.test(annotation.url)
        ) {
          continue;
        }
        const title =
          typeof annotation.title === 'string' && annotation.title.trim()
            ? annotation.title.trim()
            : annotation.url;
        citations.set(annotation.url, { title, url: annotation.url });
      }
    }
  }
  return [...citations.values()];
}

function citationMarkdown(citations: WebCitation[]): string {
  if (citations.length === 0) return '';
  const rows = citations.map(({ title, url }) => {
    // The console's deliberately small Markdown parser accepts only a simple
    // link grammar, so remove delimiter characters and encode URL parentheses.
    const safeTitle = title.replace(/[\[\]\r\n]+/g, ' ').trim() || 'Source';
    const safeUrl = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
    return `- [${safeTitle}](${safeUrl})`;
  });
  return `\n\nSources:\n${rows.join('\n')}`;
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
  const hostedWebSearch = !ctx.utility && supportsOpenAiHostedWebSearch(model);
  // One-shot utilities such as /compact intentionally have no chatId and do
  // not need (or want to pay for) a visual browser tool.
  const hostedComputer =
    !ctx.utility &&
    !!ctx.chatId &&
    ctx.mode === 'agent' &&
    ctx.approval === 'auto' &&
    supportsOpenAiComputerUse(model);
  const functionTools = (
    ctx.utility ? [] : listTools({ includeWeb: !hostedWebSearch })
  ).map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
  const tools: ResponseInputItem[] = [
    ...functionTools,
    ...(hostedWebSearch
      ? [{ type: 'web_search', search_context_size: 'medium' as const }]
      : []),
    ...(hostedComputer ? [{ type: 'computer' as const }] : []),
  ];
  const explicitCache = supportsExplicitPromptCache(model) &&
    turns.some((turn) => turn.role === 'user' && turn.content.length > 0);
  const input = responseInput(turns, explicitCache);
  const cacheKey = explicitCache ? promptCacheKey(model, ctx.chatId) : undefined;
  // Freeze the prompt for this run. Plan/memory tools can update server state
  // between model calls, but their result already tells the model what changed;
  // rebuilding the instructions here used to invalidate the entire cache on
  // every plan_update/save_memory step.
  const instructions = systemPrompt(ctx.mode, ctx.approval, ctx.chatId, {
    openAiHostedWebSearch: hostedWebSearch,
    openAiComputerUse: hostedComputer,
  });

  const maxIterations = maxAgentSteps();
  let computer: ReturnType<typeof getPublicBrowserComputer> | undefined;
  for (let i = 0; i < maxIterations; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions,
        input,
        tools: tools.length > 0 ? tools : undefined,
        reasoning: reasoningEffort ? { effort: reasoningEffort } : undefined,
        include: reasoningEffort ? ['reasoning.encrypted_content'] : undefined,
        ...(explicitCache
          ? {
              prompt_cache_key: cacheKey,
              prompt_cache_options: { mode: 'explicit' },
            }
          : {}),
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
    let usage: ResponseUsage | undefined;
    let completed = false;
    let streamError: string | null = null;
    let showedHostedWebTool = false;
    let showedComputerTool = false;
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
            usage?: ResponseUsage;
            error?: { message?: string };
            incomplete_details?: { reason?: string };
          };
          item?: { type?: string };
        };
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          emit({ type: 'text', text: event.delta });
        } else if (
          event.type === 'response.output_item.added' &&
          event.item?.type === 'web_search_call' &&
          !showedHostedWebTool
        ) {
          showedHostedWebTool = true;
          emit({ type: 'tool', name: 'openai_web_search', label: 'searched the web' });
        } else if (
          event.type === 'response.output_item.added' &&
          event.item?.type === 'computer_call' &&
          !showedComputerTool
        ) {
          showedComputerTool = true;
          emit({ type: 'tool', name: 'openai_computer', label: 'used visual browser' });
        } else if (event.type === 'response.completed') {
          output = Array.isArray(event.response?.output) ? event.response.output : [];
          usage = event.response?.usage;
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
    logResponseUsage(model, i + 1, usage);
    const citations = extractWebCitations(output);
    if (citations.length > 0) emit({ type: 'text', text: citationMarkdown(citations) });

    const calls = output.filter(
      (item): item is ResponseFunctionCall =>
        item.type === 'function_call' &&
        typeof item.call_id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.arguments === 'string',
    );
    const computerCalls = output.filter(
      (item): item is ResponseComputerCall =>
        item.type === 'computer_call' &&
        typeof item.call_id === 'string' &&
        Array.isArray(item.actions),
    );
    // Preserve ALL output items, especially encrypted reasoning items, before
    // appending the matching function_call_output records.
    input.push(...output);
    if (calls.length === 0 && computerCalls.length === 0) return;

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
    for (const call of computerCalls) {
      if (!computer) computer = getPublicBrowserComputer();
      let frame;
      try {
        frame = await computer.run(call.actions, ctx.signal);
      } catch (err) {
        if (ctx.signal?.aborted) return;
        const detail = err instanceof Error ? err.message : 'visual browser action failed';
        emit({ type: 'error', message: `OpenAI visual browser: ${detail}` });
        return;
      }
      emit({ type: 'browser', ...frame });
      input.push({
        type: 'computer_call_output',
        call_id: call.call_id,
        output: {
          type: 'computer_screenshot',
          image_url: frame.imageUrl,
          detail: 'original',
        },
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
  if (turns.some((turn) => turn.attachments?.length)) {
    emit({ type: 'error', message: `${provider} does not support attachments on this API path.` });
    return;
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const tools = (ctx.utility ? [] : listTools()).map((t) => ({
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
