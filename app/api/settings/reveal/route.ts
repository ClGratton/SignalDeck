import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { authorizeReveal } from '@/lib/reauth';
import { SERVICE_FIELDS, revealField } from '@/lib/service-config';

export const runtime = 'nodejs';

// PRIVILEGED + RE-AUTH GATED: returns ONE backend credential's effective value
// (override or env) after a fresh password + TOTP check. Returned once; the UI
// shows it masked behind an eye toggle and never persists it.
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { name?: unknown; password?: unknown; code?: unknown; grant?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (typeof body.name !== 'string' || !SERVICE_FIELDS.some((f) => f.name === body.name)) {
    return NextResponse.json({ error: 'unknown setting' }, { status: 400 });
  }
  const auth = await authorizeReveal(body);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error ?? 'Re-authentication failed.' }, { status: 403 });
  }
  const value = revealField(body.name);
  if (value == null) return NextResponse.json({ error: 'Not set.' }, { status: 404 });
  return NextResponse.json(
    { value, grant: auth.grant },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
