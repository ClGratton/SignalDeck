import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { runAnthropicTurn } from '@/lib/assistant/anthropic';
import { runGeminiTurn } from '@/lib/assistant/gemini';
import { runOpenAiTurn } from '@/lib/assistant/openai';
import { getProviderKey, getProviderBaseUrl, providerDef, PROVIDERS } from '@/lib/assistant/keys';
import { defaultModel, isKnownModel } from '@/lib/assistant/models';
import { awaitDecision } from '@/lib/assistant/decisions';
import type { ToolContext } from '@/lib/assistant/tools';
import type {
  ApprovalLevel,
  AssistantEvent,
  AssistantMode,
  AssistantProvider,
  AssistantRequestBody,
  ChatTurn,
} from '@/lib/assistant/types';

export const runtime = 'nodejs';

const MAX_TURNS = 24;
const MAX_TURN_CHARS = 6000;

/** PRIVILEGED: the operator assistant. Streams NDJSON AssistantEvents.
 *  Session-gated; provider keys live server-side only (env or stored, never
 *  echoed); action tools can only register proposals (executed separately via
 *  /api/assistant/execute, and only in agent mode). */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: AssistantRequestBody;
  try {
    body = (await req.json()) as AssistantRequestBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // Provider: the requested one if it has a key, else the first configured one.
  const requested: AssistantProvider | null =
    PROVIDERS.some((p) => p.id === body.provider) ? (body.provider as AssistantProvider) : null;
  const provider: AssistantProvider | null =
    requested && getProviderKey(requested)
      ? requested
      : (PROVIDERS.map((p) => p.id).find((id) => getProviderKey(id)) ?? null);
  if (!provider) {
    return NextResponse.json(
      { error: 'No assistant provider configured. Add an API key in the model menu (or .env.local).' },
      { status: 503 },
    );
  }
  const apiKey = getProviderKey(provider)!;

  // Model: must look like a model id AND be in the provider's known list
  // (cached live list or fallback) — otherwise the default. Never interpolate
  // arbitrary client strings into a provider URL.
  const rawModel = typeof body.model === 'string' ? body.model.trim() : '';
  const model =
    /^[\w.:-]{1,80}$/.test(rawModel) && isKnownModel(provider, rawModel)
      ? rawModel
      : defaultModel(provider);

  const mode: AssistantMode =
    body.mode === 'ask' || body.allowActions === false ? 'ask' : 'agent';
  const approval: ApprovalLevel =
    body.approval === 'critical' || body.approval === 'auto' ? body.approval : 'all';
  // Scopes the per-chat workspace (notes + plan); validated to a safe id shape.
  const chatId =
    typeof body.chatId === 'string' && /^[\w-]{1,64}$/.test(body.chatId) ? body.chatId : undefined;

  const turns: ChatTurn[] = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (t): t is ChatTurn =>
        !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string',
    )
    .slice(-MAX_TURNS)
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) }));
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'last message must be from the user' }, { status: 400 });
  }

  // Aborting the request (Stop button / closed tab) cancels the turn and
  // resolves any pending inline confirmation as "skip".
  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AssistantEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
        } catch {
          /* client went away mid-stream */
        }
      };
      const ctx: ToolContext = {
        mode,
        approval,
        emit,
        awaitDecision,
        signal: abort.signal,
        chatId,
      };
      try {
        const kind = providerDef(provider)?.kind;
        if (kind === 'anthropic') {
          await runAnthropicTurn(apiKey, model, turns, ctx);
        } else if (kind === 'gemini') {
          await runGeminiTurn(apiKey, model, turns, ctx);
        } else {
          const base = getProviderBaseUrl(provider);
          if (!base) throw new Error(`no base URL for ${provider}`);
          await runOpenAiTurn(provider, apiKey, base, model, turns, ctx);
        }
        emit({ type: 'done' });
      } catch (err) {
        // A Stop / closed tab surfaces as an abort — that's expected, not an error.
        if (!abort.signal.aborted) {
          console.error('[assistant] turn failed:', (err as Error)?.message ?? err);
          emit({ type: 'error', message: 'The assistant request failed. Try again.' });
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}
