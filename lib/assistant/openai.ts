// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: OpenAI-compatible provider adapter — serves OpenAI, DeepSeek, and
// Zhipu GLM, which all speak the /chat/completions API with the same function-
// calling shape. The base URL comes from the key store (per-provider, owner-
// configurable). Same manual loop + proposal semantics as the other adapters:
// action tools register confirmations, they never auto-run.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { systemPrompt } from '@/lib/assistant/prompt';
import { listTools, executeTool, toolLabel, type ToolContext } from '@/lib/assistant/tools';
import { maxAgentSteps } from '@/lib/assistant/config';
import type { AssistantProvider, ChatTurn } from '@/lib/assistant/types';

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
// One assistant message in OpenAI's schema (only the fields we send back).
interface OaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export async function runOpenAiTurn(
  provider: AssistantProvider,
  apiKey: string,
  baseUrl: string,
  model: string,
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
    { role: 'system', content: systemPrompt(ctx.mode, ctx.approval) },
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
        stream: true,
      }),
      cache: 'no-store',
      signal: ctx.signal,
    });

    if (!res.ok || !res.body) {
      let detail = `${provider} returned HTTP ${res.status}.`;
      try {
        const err = (await res.json()) as { error?: { message?: string } };
        if (err.error?.message) detail = `${provider}: ${err.error.message}`;
      } catch {
        /* non-JSON error body */
      }
      emit({ type: 'error', message: detail });
      return;
    }

    let text = '';
    const callsByIndex = new Map<number, ToolCall>();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
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
          continue;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
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
      }
    }

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
  }
  emit({
    type: 'error',
    message: 'Stopped after too many steps in one turn. Ask again to continue.',
  });
}
