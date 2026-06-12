// ─────────────────────────────────────────────────────────────────────────────
// TOTP (RFC 6238) verification for the second login factor.
//
// The shared secret lives ONLY in TWO_FACTOR_SECRET on the server and never
// reaches the browser — verification happens entirely inside the sign-in server
// action. Built on Web Crypto (HMAC-SHA1) so it runs in both Node and Edge,
// mirroring lib/auth.ts. Standard authenticator settings: 6 digits, 30s step.
// ─────────────────────────────────────────────────────────────────────────────

const STEP_SECONDS = 30;
const DIGITS = 6;
// Accept the adjacent steps so a little clock drift between phone and server
// doesn't reject a valid code (~±30s of tolerance).
const SKEW_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode a standard (RFC 4648) Base32 secret to bytes. Ignores padding/whitespace. */
function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return new Uint8Array(0); // invalid secret → treat as empty
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** HOTP value for a given counter, as a zero-padded DIGITS-length string. */
async function hotp(keyBytes: Uint8Array, counter: number): Promise<string> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = sig[sig.length - 1] & 0x0f;
  const binary =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** Constant-time compare of two equal-purpose strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a TOTP code against the secret. Returns the matched time step (so the
 * caller can guard against immediate replay of the same code), or null if no
 * step within the skew window matches.
 */
export async function verifyTotp(
  code: string,
  secret: string,
  atMs: number = Date.now(),
): Promise<number | null> {
  const normalized = code.replace(/\D/g, '');
  if (normalized.length !== DIGITS) return null;

  const keyBytes = base32Decode(secret);
  if (keyBytes.length === 0) return null;

  const step = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (let w = -SKEW_STEPS; w <= SKEW_STEPS; w++) {
    const candidate = await hotp(keyBytes, step + w);
    if (timingSafeEqual(candidate, normalized)) return step + w;
  }
  return null;
}
