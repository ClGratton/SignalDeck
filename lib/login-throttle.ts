// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY brute-force throttle for the sign-in action.
//
// Two layers, both in-memory (single-instance deployment; move to a shared store
// if this ever runs on more than one process):
//
// • Per-IP: 5 free failures, then an exponential lockout (30s, doubling per
//   further failure, capped at 15 minutes). Stops a single attacker from grinding
//   passwords or the 6-digit TOTP space.
// • Global circuit breaker: more than 30 failures across ALL IPs inside 10
//   minutes locks sign-in for 10 minutes. Stops a distributed attack from
//   side-stepping the per-IP limit. There's one real user, so collateral damage
//   is "you wait ten minutes during an active attack" — acceptable.
//
// A restart clears the counters; that's fine because a restart also isn't
// something an attacker can trigger, and the per-attempt cost remains.
// ─────────────────────────────────────────────────────────────────────────────

const FREE_FAILURES = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 10 * 60_000;
const GLOBAL_MAX_FAILURES = 30;
const ENTRY_TTL_MS = 60 * 60_000; // forget an IP after an hour of silence

interface Entry {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

const perIp = new Map<string, Entry>();
let globalFailures: number[] = []; // timestamps of recent failures

function prune(now: number): void {
  globalFailures = globalFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (perIp.size > 1000) {
    for (const [ip, e] of perIp) {
      if (now - e.lastSeen > ENTRY_TTL_MS) perIp.delete(ip);
    }
  }
}

/**
 * Gate a sign-in attempt. Returns null when the attempt may proceed, or the
 * number of seconds the caller must wait.
 */
export function checkThrottle(ip: string, now: number = Date.now()): number | null {
  prune(now);
  if (globalFailures.length >= GLOBAL_MAX_FAILURES) {
    const oldest = globalFailures[0];
    return Math.max(1, Math.ceil((oldest + GLOBAL_WINDOW_MS - now) / 1000));
  }
  const e = perIp.get(ip);
  if (e && e.lockedUntil > now) return Math.max(1, Math.ceil((e.lockedUntil - now) / 1000));
  return null;
}

/** Record a failed attempt and compute the next lockout for this IP. */
export function recordFailure(ip: string, now: number = Date.now()): void {
  globalFailures.push(now);
  const e = perIp.get(ip) ?? { failures: 0, lockedUntil: 0, lastSeen: now };
  e.failures += 1;
  e.lastSeen = now;
  if (e.failures > FREE_FAILURES) {
    const exponent = e.failures - FREE_FAILURES - 1;
    e.lockedUntil = now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** exponent);
  }
  perIp.set(ip, e);
  console.warn(`[auth] failed sign-in from ${ip} (${e.failures} recent failures)`);
}

/** Clear an IP's slate after a successful sign-in. */
export function recordSuccess(ip: string): void {
  perIp.delete(ip);
}
