import { NextResponse, type NextRequest } from 'next/server';
import { cookies, headers } from 'next/headers';
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from '@/lib/auth';
import { getAuthEpoch } from '@/lib/auth-store';
import { peekHandoff, redeemHandoff } from '@/lib/auth-handoff';
import { createSession, deviceLabel, absoluteMaxMs } from '@/lib/session-store';
import { checkThrottle, recordFailure, recordSuccess } from '@/lib/login-throttle';

export const runtime = 'nodejs';

const TOKEN_RE = /^[\w-]{20,128}$/;

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

/** NOT session-gated by design — this is how a NOT-yet-authenticated phone signs
 *  in. The handoff token (minted by an already-authed desktop, single-use, ~60s,
 *  32 bytes of CSPRNG) is the credential. GET peeks the source device for the
 *  confirm prompt; POST consumes the token and mints the phone's session. */
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ valid: false }, { status: 400 });
  }
  const peek = peekHandoff(token);
  if (!peek) {
    return NextResponse.json({ valid: false }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  return NextResponse.json(
    { valid: true, sourceLabel: peek.sourceLabel },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export async function POST(req: NextRequest) {
  const ip = await clientIp();
  // Brute-force gate first (the token is unguessable, but defend the endpoint).
  const wait = checkThrottle(ip);
  if (wait != null) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${wait}s.` }, { status: 429 });
  }

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Sign-in is not configured.' }, { status: 500 });
  }

  let body: { token?: unknown };
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const token = typeof body.token === 'string' ? body.token : '';
  if (!TOKEN_RE.test(token) || !redeemHandoff(token)) {
    recordFailure(ip);
    return NextResponse.json({ error: 'This sign-in link has expired. Show a new QR on the desktop.' }, { status: 401 });
  }
  recordSuccess(ip);

  // Mint the phone's OWN session (own device label + ip), subject to the same
  // concurrent-session limit as a password login.
  const ua = (await headers()).get('user-agent');
  const sessionId = createSession(deviceLabel(ua), ip);
  const sessionToken = await createSessionToken(secret, getAuthEpoch(), sessionId);
  (await cookies()).set(SESSION_COOKIE, sessionToken, sessionCookieOptions(absoluteMaxMs() / 1000));
  return NextResponse.json({ ok: true, dest: '/dashboard' }, { headers: { 'Cache-Control': 'private, no-store' } });
}
