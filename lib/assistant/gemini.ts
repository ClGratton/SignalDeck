// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: Gemini provider — fallback while no ANTHROPIC_API_KEY is set
// (the owner currently has a GEMINI_API_KEY). Same tool surface and the same
// manual loop semantics as the Anthropic adapter. Plain fetch + SSE; the key
// travels in a header, never in the URL.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { systemPrompt } from '@/lib/assistant/prompt';
import { listTools, executeTool, toolLabel, type ToolContext } from '@/lib/assistant/tools';
import { maxAgentSteps } from '@/lib/assistant/config';
import { readAttachment } from '@/lib/assistant/attachments';
import type { ChatTurn } from '@/lib/assistant/types';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
  /** Gemini 3.x signs its function calls; the signature MUST be echoed back on
   *  the same part in the next request or tool use degrades (API warns). */
  thoughtSignature?: string;
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export async function runGeminiTurn(
  apiKey: string,
  model: string,
  turns: ChatTurn[],
  ctx: ToolContext,
): Promise<void> {
  const emit = ctx.emit;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  const contents: GeminiContent[] = turns.map((t) => {
    const parts: GeminiPart[] = t.content ? [{ text: t.content }] : [];
    if (t.role === 'user') {
      for (const ref of t.attachments ?? []) {
        const attachment = readAttachment(ref.id);
        parts.push({
          inlineData: { mimeType: attachment.mimeType, data: attachment.bytes.toString('base64') },
        });
      }
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const declarations = (ctx.utility ? [] : listTools()).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
  const tools = declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
  // Gemini 2.5+ applies implicit prefix caching automatically. Keeping this
  // fixed during the loop gives that native cache a stable system prefix;
  // older models simply ignore the optimization without receiving new fields.
  const instructions = systemPrompt(ctx.mode, ctx.approval, ctx.chatId);

  const maxIterations = maxAgentSteps();
  for (let i = 0; i < maxIterations; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents,
        tools,
      }),
      cache: 'no-store',
      signal: ctx.signal,
    });

    if (!res.ok || !res.body) {
      let detail = `Gemini returned HTTP ${res.status}.`;
      try {
        const err = (await res.json()) as { error?: { message?: string } };
        if (err.error?.message) detail = `Gemini: ${err.error.message}`;
      } catch {
        /* non-JSON error body */
      }
      emit({ type: 'error', message: detail });
      return;
    }

    // Parse the SSE stream: each `data: {...}` line is a GenerateContentResponse
    // chunk. Text parts stream out as deltas; functionCall parts are collected.
    const modelParts: GeminiPart[] = [];
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: GeminiUsageMetadata | undefined;
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
          candidates?: { content?: { parts?: GeminiPart[] } }[];
          usageMetadata?: GeminiUsageMetadata;
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) {
            emit(part.thought ? { type: 'reasoning', text: part.text } : { type: 'text', text: part.text });
            modelParts.push({
              text: part.text,
              ...(part.thought ? { thought: true } : {}),
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            });
          }
          if (part.functionCall) {
            calls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
            modelParts.push({
              functionCall: part.functionCall,
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            });
          }
        }
      }
    }
    if (usage) {
      console.info('[assistant] Gemini token usage', {
        model,
        request: i + 1,
        inputTokens: usage.promptTokenCount ?? 0,
        cachedTokens: usage.cachedContentTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        reasoningTokens: usage.thoughtsTokenCount ?? 0,
        totalTokens: usage.totalTokenCount ?? 0,
      });
    }

    if (modelParts.length > 0) contents.push({ role: 'model', parts: modelParts });
    if (calls.length === 0) return; // plain answer — turn complete

    const responses: GeminiPart[] = [];
    for (const call of calls) {
      emit({ type: 'tool', name: call.name, label: toolLabel(call.name) });
      const outcome = await executeTool(call.name, call.args, ctx);
      responses.push({
        functionResponse: { name: call.name, response: { result: outcome.content } },
      });
    }
    contents.push({ role: 'user', parts: responses });
    // start_timer asked to end the turn and hand the wait to the task runner.
    if (ctx.sleep) return;
  }
  emit({
    type: 'error',
    message: 'Stopped after too many steps in one turn. Ask again to continue.',
  });
}
