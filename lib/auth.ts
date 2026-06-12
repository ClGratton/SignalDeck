// Minimal single-user session token, signed with AUTH_SECRET via Web Crypto so it
// works in both the Node (server action) and Edge (middleware) runtimes. The
// cookie is tamper-resistant: a visitor cannot forge a valid token without the
// secret. This is intentionally small; richer auth (multi-user, providers,
// rotation) is shaped alongside the dashboard.

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days
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
 * Create a signed session token bound to the current auth epoch. Bumping the
 * epoch (lib/auth-store.ts) invalidates every outstanding token — the real
 * "sign out everywhere" switch, without rotating AUTH_SECRET.
 */
export async function createSessionToken(secret: string, epoch: number): Promise<string> {
  const payload = `g.${epoch}.${Date.now()}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${toBase64Url(sig)}`;
}

/** Verify signature, epoch, and that the token has not exceeded the max age. */
export async function verifySessionToken(
  token: string | undefined,
  secret: string,
  epoch: number,
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const [prefix, tokenEpoch, issuedAt, sig] = parts;
  const payload = `${prefix}.${tokenEpoch}.${issuedAt}`;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig), encoder.encode(payload));
    if (!ok) return false;
    if (tokenEpoch !== String(epoch)) return false; // revoked generation
    const age = (Date.now() - Number(issuedAt)) / 1000;
    return Number.isFinite(age) && age >= 0 && age < SESSION_MAX_AGE_SECONDS;
  } catch {
    return false;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
};
