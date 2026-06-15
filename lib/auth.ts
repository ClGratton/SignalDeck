// Minimal single-user session token, signed with AUTH_SECRET via Web Crypto so it
// works in both the Node (server action) and Edge (middleware) runtimes. The
// cookie is tamper-resistant: a visitor cannot forge a valid token without the
// secret. This is intentionally small; richer auth (multi-user, providers,
// rotation) is shaped alongside the dashboard.

// A generous HARD ceiling baked into the token itself (defense in depth); the
// real, owner-configurable absolute/idle limits are enforced by the session
// registry (lib/session-store.ts). A token older than this is never valid even
// if the registry was wiped.
const TOKEN_HARD_MAX_AGE_SECONDS = 60 * 60 * 24 * 60; // 60 days
export const SESSION_COOKIE = 'grtlabs_session';

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Create a signed session token bound to the current auth epoch AND a session id
 * (which keys the registry in lib/session-store.ts). Bumping the epoch
 * (lib/auth-store.ts) invalidates every outstanding token — the "sign out
 * everywhere" switch; revoking the session id drops just that one.
 */
export async function createSessionToken(
  secret: string,
  epoch: number,
  sessionId: string,
): Promise<string> {
  const payload = `g.${epoch}.${sessionId}.${Date.now()}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${toBase64Url(sig)}`;
}

/** Verify signature, epoch and the hard age cap; return the embedded sessionId
 *  (so the caller can validate it against the registry) or null. Pure crypto —
 *  no fs — so it stays usable from the Edge as well as Node. */
export async function parseSessionToken(
  token: string | undefined,
  secret: string,
  epoch: number,
): Promise<{ sessionId: string } | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null; // g.<epoch>.<sessionId>.<issuedAt>.<sig>
  const [prefix, tokenEpoch, sessionId, issuedAt, sig] = parts;
  const payload = `${prefix}.${tokenEpoch}.${sessionId}.${issuedAt}`;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig), encoder.encode(payload));
    if (!ok) return null;
    if (tokenEpoch !== String(epoch)) return null; // revoked generation
    const age = (Date.now() - Number(issuedAt)) / 1000;
    if (!Number.isFinite(age) || age < 0 || age >= TOKEN_HARD_MAX_AGE_SECONDS) return null;
    if (!/^[\w-]{1,64}$/.test(sessionId)) return null;
    return { sessionId };
  } catch {
    return null;
  }
}

/** Read the sessionId out of a token WITHOUT verifying it (cookie is httpOnly
 *  and already validated elsewhere) — for tagging the current row in the list. */
export function sessionIdOf(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  return parts.length === 5 && /^[\w-]{1,64}$/.test(parts[2]) ? parts[2] : null;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.min(Math.max(Math.floor(maxAgeSeconds), 60), TOKEN_HARD_MAX_AGE_SECONDS),
  };
}
