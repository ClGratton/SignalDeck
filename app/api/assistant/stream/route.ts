import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { streamFrames, liveTaskStatus } from '@/lib/assistant/tasks';

export const runtime = 'nodejs';

/** PRIVILEGED: reattach to a chat's in-flight (or sleeping/just-finished)
 *  server-side agent task. Replays every frame after `from` (the last seq the
 *  client saw) then streams live ones. Used after a reload, a dropped
 *  connection, or when a server-side timer is about to wake — the client opens
 *  this instead of holding a connection open through a long wait. 404 if no task
 *  is attached (the client then just renders the stored transcript). */
export async function GET(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = new URL(req.url);
  const chatId = url.searchParams.get('chatId') ?? '';
  if (!/^[\w-]{1,64}$/.test(chatId)) {
    return NextResponse.json({ error: 'invalid chatId' }, { status: 400 });
  }
  const fromRaw = Number(url.searchParams.get('from') ?? '0');
  const from = Number.isFinite(fromRaw) && fromRaw >= 0 ? Math.floor(fromRaw) : 0;

  if (!liveTaskStatus(chatId)) {
    return NextResponse.json({ error: 'no live task' }, { status: 404 });
  }
  const stream = streamFrames(chatId, from);
  if (!stream) {
    return NextResponse.json({ error: 'no live task' }, { status: 404 });
  }
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}
