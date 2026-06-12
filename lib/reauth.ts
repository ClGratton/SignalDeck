// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: fresh credential re-verification for sensitive reads.
//
// Viewing a stored secret in the browser is gated behind the SAME factors as
// signing in — password (constant-time) + TOTP (single-use, replay-guarded) —
// even though the visitor already holds a valid session. Reuses the login
// throttle and the persisted TOTP step, so a code burned here can't be replayed
// at /login and vice versa. Returns a generic failure; never says which factor
// was wrong.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { headers } from 'next/headers';
import { getLastTotpStep, setLastTotpStep } from '@/lib/auth-store';
import { checkThrottle, recordFailure, recordSuccess } from '@/lib/login-throttle';
import { verifyTotp } from '@/lib/totp';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
  );
}

export interface ReauthResult {
  ok: boolean;
  /** Generic, factor-agnostic message on failure. */
  error?: string;
  /** Seconds to wait when throttled. */
  retryAfter?: number;
}

/** Verify password (+ TOTP when configured) for a sensitive in-session action. */
export async function reverifyCredentials(password: string, code: string): Promise<ReauthResult> {
  const expected = process.env.DASHBOARD_PASSWORD;
  const totpSecret = process.env.TWO_FACTOR_SECRET;
  if (!expected) return { ok: false, error: 'Re-auth is not configured.' };

  const ip = await clientIp();
  const wait = checkThrottle(ip);
  if (wait != null) return { ok: false, error: `Too many attempts. Try again in ${wait}s.`, retryAfter: wait };

  if (!password || (totpSecret && !code)) {
    recordFailure(ip);
    return { ok: false, error: 'Enter your password and authentication code.' };
  }

  const passwordOk = timingSafeEqual(password, expected);
  const matchedStep = totpSecret ? await verifyTotp(code, totpSecret) : null;
  const codeOk = totpSecret ? matchedStep !== null && matchedStep > getLastTotpStep() : true;

  if (!passwordOk || !codeOk) {
    recordFailure(ip);
    return { ok: false, error: 'Incorrect password or authentication code.' };
  }

  if (totpSecret && matchedStep !== null) setLastTotpStep(matchedStep);
  recordSuccess(ip);
  return { ok: true };
}

// ── Reveal grant ─────────────────────────────────────────────────────────────
// A successful re-auth mints a short-lived grant so the owner can reveal several
// secrets within one window without burning a fresh TOTP code each time (codes
// are single-use). The grant is HMAC-signed with AUTH_SECRET, expires in 2
// minutes, is bound to purpose "reveal", and is held only in memory client-side.

const GRANT_TTL_MS = 2 * 60_000;
const encoder = new TextEncoder();

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function mintRevealGrant(): Promise<string | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const payload = `reveal.${Date.now() + GRANT_TTL_MS}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifyRevealGrant(token: string | undefined): Promise<boolean> {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'reveal') return false;
  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const expected = await hmac(secret, `reveal.${parts[1]}`);
  return timingSafeEqual(expected, parts[2]);
}

/** Shared gate for reveal routes: a valid unexpired grant, OR a fresh password +
 *  TOTP. On success via credentials, returns a new grant to extend the window. */
export async function authorizeReveal(body: {
  grant?: unknown;
  password?: unknown;
  code?: unknown;
}): Promise<{ ok: boolean; grant?: string; error?: string }> {
  if (typeof body.grant === 'string' && (await verifyRevealGrant(body.grant))) {
    return { ok: true, grant: body.grant };
  }
  const res = await reverifyCredentials(String(body.password ?? ''), String(body.code ?? ''));
  if (!res.ok) return { ok: false, error: res.error };
  const grant = await mintRevealGrant();
  return { ok: true, grant: grant ?? undefined };
}
