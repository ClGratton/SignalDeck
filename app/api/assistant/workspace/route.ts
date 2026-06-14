import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { getWorkspace, clearWorkspace } from '@/lib/assistant/chat-workspace';

export const runtime = 'nodejs';

const validId = (id: string | null): id is string => !!id && /^[\w-]{1,64}$/.test(id);

/** PRIVILEGED: a chat's scratch workspace (notes + plan). Session-gated like the
 *  rest of the assistant routes — it can hold operator task detail. */
export async function GET(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const chatId = req.nextUrl.searchParams.get('chatId');
  if (!validId(chatId)) return NextResponse.json({ error: 'bad chatId' }, { status: 400 });
  return NextResponse.json({ workspace: getWorkspace(chatId) });
}

/** Operator clears this chat's notes, plan, or both. */
export async function DELETE(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { chatId?: string; what?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* allow query-param form too */
  }
  const chatId = body.chatId ?? req.nextUrl.searchParams.get('chatId');
  if (!validId(chatId ?? null)) return NextResponse.json({ error: 'bad chatId' }, { status: 400 });
  const whatRaw = body.what ?? req.nextUrl.searchParams.get('what') ?? 'all';
  const what = whatRaw === 'notes' || whatRaw === 'plan' ? whatRaw : 'all';
  return NextResponse.json({ workspace: clearWorkspace(chatId as string, what) });
}
