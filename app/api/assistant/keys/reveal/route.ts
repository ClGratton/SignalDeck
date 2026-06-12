import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { authorizeReveal } from '@/lib/reauth';
import { getProviderKey, PROVIDERS } from '@/lib/assistant/keys';
import type { AssistantProvider } from '@/lib/assistant/types';

export const runtime = 'nodejs';

// PRIVILEGED + RE-AUTH GATED: returns ONE model-provider key value, but only
// after a fresh password + TOTP re-verification (on top of the existing
// session). The value is returned once and never persisted client-side.
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { provider?: unknown; password?: unknown; code?: unknown; grant?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!PROVIDERS.some((p) => p.id === body.provider)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }
  const auth = await authorizeReveal(body);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error ?? 'Re-authentication failed.' }, { status: 403 });
  }
  const value = getProviderKey(body.provider as AssistantProvider);
  if (!value) return NextResponse.json({ error: 'No key set for this provider.' }, { status: 404 });
  return NextResponse.json(
    { value, grant: auth.grant },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
