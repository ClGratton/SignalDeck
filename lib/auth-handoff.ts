// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: QR cross-device login handoff tokens.
//
// An already-authenticated DESKTOP mints a single-use, ~60-second handoff token
// bound to its own session and renders it as a QR code. A MOBILE device scans
// the QR (which points at /login/qr#<token>), confirms "sign in from <desktop>?",
// and redeems the token — the server then mints a NEW mobile session. The secret
// only ever lives on the desktop screen, can't be replayed (single-use), and
// expires in a minute, so an attacker would have to physically see the screen.
//
// In-memory only (per-process): a 60s token isn't worth persisting, and a server
// restart simply means re-showing the QR. Same single-instance caveat as the
// rest of the auth state.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { randomBytes } from 'node:crypto';

interface HandoffToken {
  token: string;
  /** The desktop session that minted it (for the "from <device>" prompt). */
  sourceLabel: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

const TTL_MS = 60_000;
const tokens = new Map<string, HandoffToken>();

function sweep(now: number): void {
  for (const [k, v] of tokens) if (v.used || now > v.expiresAt) tokens.delete(k);
}

/** Mint a single-use handoff token. `sourceLabel` is the desktop's device label,
 *  shown to the person on the phone before they confirm. */
export function mintHandoff(sourceLabel: string): { token: string; expiresAt: number } {
  const now = Date.now();
  sweep(now);
  // 32 bytes of CSPRNG → URL-safe base64; unguessable within the 60s window.
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + TTL_MS;
  tokens.set(token, { token, sourceLabel, createdAt: now, expiresAt, used: false });
  return { token, expiresAt };
}

/** Look up a handoff token WITHOUT consuming it (for the mobile confirm prompt). */
export function peekHandoff(token: string): { sourceLabel: string } | null {
  const now = Date.now();
  sweep(now);
  const t = tokens.get(token);
  if (!t || t.used || now > t.expiresAt) return null;
  return { sourceLabel: t.sourceLabel };
}

/** Consume a handoff token: valid + single-use. Returns true exactly once. */
export function redeemHandoff(token: string): boolean {
  const now = Date.now();
  sweep(now);
  const t = tokens.get(token);
  if (!t || t.used || now > t.expiresAt) return false;
  t.used = true;
  tokens.delete(token);
  return true;
}
