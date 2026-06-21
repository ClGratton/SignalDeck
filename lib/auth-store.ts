// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY durable auth state: the session epoch and the last-used TOTP step.
//
// • Epoch: every session token embeds the epoch it was minted under; verification
//   rejects tokens from older epochs. Bumping the epoch is therefore a real
//   "sign out everywhere" kill switch that survives restarts — no need to rotate
//   AUTH_SECRET.
// • TOTP step: the time step of the last successfully used code. Persisting it
//   closes the small window where a server restart would let a just-used code be
//   replayed within its ~90s validity.
//
// Stored in data/auth-state.json (gitignored). Mirrored in memory so reads are
// free; the file is only touched on change. Read/write failures degrade safely
// (epoch 1, no step) rather than throwing.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

interface AuthState {
  epoch: number;
  totpStep: number;
}

const FILE = path.join(process.cwd(), 'data', 'auth-state.json');

let mem: AuthState | null = null;
// Mtime (ms) of the file backing `mem`. The cache must NOT be permanent: Next.js
// runs the login server action, the API routes, and middleware in separate module
// instances / worker processes, each with its own `mem`, all sharing this one
// file. If `load()` cached forever (the old `if (mem) return mem`) on a
// multi-instance deploy: (1) a TOTP step burned by one instance is invisible to
// another, so the SAME code can be replayed on a different worker — breaking the
// load-bearing single-use-TOTP invariant for both login and the destructive
// re-auth gate; and (2) a "sign out everywhere" epoch bump only takes effect on
// the instance that ran it. Re-reading on mtime change makes all instances
// converge on the shared file. (See the same fix in lib/session-store.ts.)
let memMtime = -1;

function fileMtimeMs(): number {
  try {
    return fs.statSync(FILE).mtimeMs;
  } catch {
    return 0; // no file yet
  }
}

function load(): AuthState {
  const mtime = fileMtimeMs();
  if (mem && mtime === memMtime) return mem;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<AuthState>;
    mem = {
      epoch: typeof raw.epoch === 'number' && raw.epoch >= 1 ? raw.epoch : 1,
      totpStep: typeof raw.totpStep === 'number' ? raw.totpStep : -1,
    };
  } catch {
    mem = { epoch: 1, totpStep: -1 };
  }
  memMtime = mtime;
  return mem;
}

function persist(state: AuthState): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
    memMtime = fileMtimeMs(); // our mem matches disk; don't re-read our own write
  } catch (err) {
    console.error('[auth] state write failed:', (err as Error)?.message ?? err);
  }
}

/** Current session epoch. Tokens minted under an older epoch are invalid. */
export function getAuthEpoch(): number {
  return load().epoch;
}

/** Invalidate EVERY outstanding session (sign out everywhere). */
export function bumpAuthEpoch(): number {
  const state = load();
  state.epoch += 1;
  persist(state);
  return state.epoch;
}

/** Last TOTP step consumed by a successful sign-in. */
export function getLastTotpStep(): number {
  return load().totpStep;
}

/** Burn a TOTP step so the same code can't be replayed, even across restarts. */
export function setLastTotpStep(step: number): void {
  const state = load();
  if (step > state.totpStep) {
    state.totpStep = step;
    persist(state);
  }
}
