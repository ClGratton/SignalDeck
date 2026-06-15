import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession, currentSessionId } from '@/lib/session';
import { listSessions, revokeSession, revokeOthers } from '@/lib/session-store';

export const runtime = 'nodejs';

/** PRIVILEGED: the operator's active sessions (devices). GET lists them (with
 *  "this device" tagged); DELETE drops one by id, or every other device. Drops
 *  take effect on that device's NEXT request (its session id is gone from the
 *  registry, so validateSession fails and the middleware bounces it to /login). */
export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const current = await currentSessionId();
  return NextResponse.json(
    { sessions: listSessions(current), currentId: current },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function DELETE(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { id?: unknown; others?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; others?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (body.others === true) {
    const current = await currentSessionId();
    if (!current) return NextResponse.json({ error: 'no current session' }, { status: 400 });
    revokeOthers(current);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  if (typeof body.id === 'string' && /^[\w-]{1,64}$/.test(body.id)) {
    revokeSession(body.id);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  return NextResponse.json({ error: 'id or others required' }, { status: 400 });
}
