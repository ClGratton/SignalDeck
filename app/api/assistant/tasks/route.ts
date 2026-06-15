import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { liveTaskStatuses, stopTask } from '@/lib/assistant/tasks';

export const runtime = 'nodejs';

/** PRIVILEGED: the live server-side agent tasks (one per chat). A client polls
 *  this on load to discover which chats have a turn still running/sleeping so it
 *  can reattach (GET /api/assistant/stream). Reports status only — no transcript
 *  content (that comes from /api/assistant/chats). */
export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { tasks: liveTaskStatuses() },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/** Stop a chat's task (operator pressed Stop). */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { chatId?: unknown };
  try {
    body = (await req.json()) as { chatId?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  if (!/^[\w-]{1,64}$/.test(chatId)) {
    return NextResponse.json({ error: 'invalid chatId' }, { status: 400 });
  }
  const stopped = stopTask(chatId);
  return NextResponse.json({ ok: stopped }, { headers: { 'Cache-Control': 'private, no-store' } });
}
