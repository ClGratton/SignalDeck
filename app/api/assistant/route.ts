import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { getProviderKey, providerDef, PROVIDERS } from '@/lib/assistant/keys';
import { defaultModel, isKnownModel, resolveReasoningEffort } from '@/lib/assistant/models';
import { startTask, streamFrames, streamHeaders } from '@/lib/assistant/tasks';
import type {
  ApprovalLevel,
  AssistantMode,
  AssistantProvider,
  AssistantRequestBody,
  ChatTurn,
} from '@/lib/assistant/types';

export const runtime = 'nodejs';

const MAX_TURNS = 24;
const MAX_TURN_CHARS = 6000;

/** PRIVILEGED: the operator assistant. Starts a SERVER-SIDE agent task for the
 *  chat (decoupled from this request) and streams its NDJSON frames. The task
 *  keeps running if this request is aborted (reload / closed tab / logout); the
 *  client reattaches via GET /api/assistant/stream. Session-gated; provider keys
 *  live server-side only; action tools pause for the operator's approval. */
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

  // Model: must look like a model id AND be in the provider's known list.
  const rawModel = typeof body.model === 'string' ? body.model.trim() : '';
  const model =
    /^[\w.:-]{1,80}$/.test(rawModel) && isKnownModel(provider, rawModel)
      ? rawModel
      : defaultModel(provider);
  const reasoningEffort = resolveReasoningEffort(provider, model, body.reasoningEffort);

  const mode: AssistantMode = body.mode === 'ask' || body.allowActions === false ? 'ask' : 'agent';
  const approval: ApprovalLevel =
    body.approval === 'critical' || body.approval === 'auto' ? body.approval : 'all';

  // chatId keys the task (and its reattach stream), so it's required now.
  const chatId =
    typeof body.chatId === 'string' && /^[\w-]{1,64}$/.test(body.chatId) ? body.chatId : null;
  if (!chatId) {
    return NextResponse.json({ error: 'chatId is required.' }, { status: 400 });
  }

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

  // The clean user text for the transcript item: strip the optional "[context:
  // …]" prefix the client prepends (it's plumbing, not the operator's words).
  const userText = turns[turns.length - 1].content.replace(/^\[context:[^\]]*\]\n/, '');

  const started = startTask({
    chatId,
    provider,
    model,
    reasoningEffort,
    mode,
    approval,
    turns,
    userText,
  });
  if (!started.ok) {
    // A task for this chat is already in flight — the client should reattach.
    return NextResponse.json({ error: started.reason, reattach: true }, { status: 409 });
  }

  const stream = streamFrames(chatId, 0);
  if (!stream) {
    // Raced to terminal before we could attach (extremely fast/empty turn);
    // the result is already in the chat store — tell the client to reload it.
    return NextResponse.json({ ok: true, reattach: true }, { status: 202 });
  }
  return new Response(stream, { headers: streamHeaders() });
}
