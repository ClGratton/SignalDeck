import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { runAnthropicTurn } from '@/lib/assistant/anthropic';
import { runGeminiTurn } from '@/lib/assistant/gemini';
import { runOpenAiTurn } from '@/lib/assistant/openai';
import { getProviderKey, getProviderBaseUrl, providerDef, PROVIDERS } from '@/lib/assistant/keys';
import { defaultModel, isKnownModel, resolveReasoningEffort } from '@/lib/assistant/models';
import { awaitDecision } from '@/lib/assistant/decisions';
import { streamHeaders } from '@/lib/assistant/tasks';
import type { ToolContext } from '@/lib/assistant/tools';
import type {
  AssistantEvent,
  AssistantProvider,
  AssistantRequestBody,
  ChatTurn,
} from '@/lib/assistant/types';

export const runtime = 'nodejs';

const MAX_TURNS = 40;
const MAX_TURN_CHARS = 8000;

/** PRIVILEGED: an EPHEMERAL, request-scoped assistant turn — for one-off
 *  utilities like /compact that just need streamed text and have NO durable
 *  result. Unlike POST /api/assistant (which spawns a survivable server-side
 *  task), this runs inline and dies with the request: a dropped connection just
 *  means re-run it. It is Ask-mode only, so action tools can only ever propose,
 *  never execute. */
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

  const requested: AssistantProvider | null =
    PROVIDERS.some((p) => p.id === body.provider) ? (body.provider as AssistantProvider) : null;
  const provider: AssistantProvider | null =
    requested && getProviderKey(requested)
      ? requested
      : (PROVIDERS.map((p) => p.id).find((id) => getProviderKey(id)) ?? null);
  if (!provider) {
    return NextResponse.json({ error: 'No assistant provider configured.' }, { status: 503 });
  }
  const apiKey = getProviderKey(provider)!;

  const rawModel = typeof body.model === 'string' ? body.model.trim() : '';
  const model =
    /^[\w.:-]{1,80}$/.test(rawModel) && isKnownModel(provider, rawModel)
      ? rawModel
      : defaultModel(provider);
  const reasoningEffort = resolveReasoningEffort(provider, model, body.reasoningEffort);

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

  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort(), { once: true });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AssistantEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
        } catch {
          /* client went away */
        }
      };
      // Ask mode → action tools only ever propose; awaitDecision is unused here.
      const ctx: ToolContext = {
        mode: 'ask',
        approval: 'all',
        emit,
        awaitDecision,
        signal: abort.signal,
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
          await runOpenAiTurn(provider, apiKey, base, model, reasoningEffort, turns, ctx);
        }
        emit({ type: 'done' });
      } catch (err) {
        if (!abort.signal.aborted) {
          emit({ type: 'error', message: 'The request failed. Try again.' });
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

  return new Response(stream, { headers: streamHeaders() });
}
