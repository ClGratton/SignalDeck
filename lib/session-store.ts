// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the active-session registry.
//
// Sessions used to be purely stateless (a signed HMAC cookie + a global epoch).
// That gave a "sign out everywhere" switch but no per-session control: no idle
// timeout, no absolute cap you can tune, no concurrent-session limit, no "drop
// THAT device". This registry adds them. Each session token now embeds a
// sessionId (lib/auth.ts) that keys a record here; the middleware + hasValidSession
// validate-and-touch it on every request.
//
//   • Idle (rolling) timeout — refreshed on each request, so active use is never
//     interrupted; expires only after N minutes of no activity. 0 = disabled.
//   • Absolute max — a hard ceiling from issue time regardless of activity.
//   • Concurrent limit — at most N live sessions; a new login evicts the oldest
//     (by last activity). Limit 1 ⇒ signing in on a new device drops the old one.
//
// Persisted to data/sessions.json (gitignored). Same accepted single-instance
// limit as the login throttle + auth epoch: per-process. lastSeen writes are
// throttled so a busy request path doesn't hammer the disk.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cfg } from '@/lib/service-config';

export interface SessionRecord {
  id: string;
  issuedAt: number;
  lastSeen: number;
  /** Coarse device label derived from the User-Agent (never anything sensitive). */
  label: string;
  /** Best-effort client IP for the operator's "is this me?" check. */
  ip: string;
}

const FILE = path.join(process.cwd(), 'data', 'sessions.json');
const PERSIST_MIN_INTERVAL_MS = 30_000; // throttle lastSeen writes

let mem: SessionRecord[] | null = null;
// Mtime (ms) of the file backing the cached `mem`. The cache is NOT permanent:
// Next.js runs the login server action and the API route handlers in separate
// module instances / worker processes, each with its OWN `mem`, all writing this
// one file. If `load()` cached forever (the old `if (mem) return mem`), an
// instance that loaded `mem` at startup never saw a session ANOTHER instance
// wrote later — so every new login validated as "session expired" on whichever
// worker happened to serve the request, and a stale instance's persist() could
// CLOBBER the file, deleting sessions others had created. Only the session that
// happened to be on disk when this instance first loaded ever worked. Re-reading
// on mtime change makes all instances converge on the shared file.
let memMtime = -1;
let lastPersist = 0;

function fileMtimeMs(): number {
  try {
    return fs.statSync(FILE).mtimeMs;
  } catch {
    return 0; // no file yet
  }
}

function load(): SessionRecord[] {
  const mtime = fileMtimeMs();
  if (mem && mtime === memMtime) return mem;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    mem = Array.isArray(raw)
      ? (raw as SessionRecord[]).filter(
          (r) => r && typeof r.id === 'string' && typeof r.issuedAt === 'number',
        )
      : [];
  } catch {
    mem = [];
  }
  memMtime = mtime;
  return mem;
}

function persist(force = false): void {
  const now = Date.now();
  if (!force && now - lastPersist < PERSIST_MIN_INTERVAL_MS) return;
  lastPersist = now;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(mem ?? []));
    // Our `mem` now matches disk; record the mtime so the next load() doesn't
    // needlessly re-read our own write (only ANOTHER instance's write re-reads).
    memMtime = fileMtimeMs();
  } catch (err) {
    console.error('[session] store write failed:', (err as Error)?.message ?? err);
  }
}

// ── Tunables (Settings → Security & sessions) ────────────────────────────────

/** Idle timeout in ms (0 = disabled). Refreshed on every request. */
export function idleTimeoutMs(): number {
  const m = Number(cfg('AUTH_SESSION_IDLE_MINUTES'));
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.min(Math.max(m, 1), 10080) * 60_000; // 1 min … 7 days
}

/** Absolute max session age in ms (hard ceiling). Default 7 days. */
export function absoluteMaxMs(): number {
  const h = Number(cfg('AUTH_SESSION_MAX_HOURS'));
  if (!Number.isFinite(h) || h <= 0) return 168 * 3_600_000; // 7 days
  return Math.min(Math.max(h, 1), 1440) * 3_600_000; // 1h … 60 days
}

/** Max concurrent sessions (0 = unlimited). */
export function maxSessions(): number {
  const n = Number(cfg('AUTH_MAX_SESSIONS'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 50);
}

/** Whether login requires the TOTP code (only relevant if TWO_FACTOR_SECRET is
 *  set). Default ON; the owner can disable it in Settings. */
export function loginRequires2fa(): boolean {
  return !/^(false|0|no|off)$/i.test((cfg('AUTH_REQUIRE_2FA') ?? '').trim());
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function expired(r: SessionRecord, now: number): boolean {
  const idle = idleTimeoutMs();
  if (idle > 0 && now - r.lastSeen > idle) return true;
  if (now - r.issuedAt > absoluteMaxMs()) return true;
  return false;
}

/** Drop expired sessions. Returns whether anything changed. */
function prune(now: number): boolean {
  const list = load();
  const kept = list.filter((r) => !expired(r, now));
  if (kept.length === list.length) return false;
  mem = kept;
  return true;
}

/** Create + register a session, enforcing the concurrent limit (evict the
 *  least-recently-active when over). Returns the new session id. */
export function createSession(label: string, ip: string): string {
  const now = Date.now();
  prune(now);
  const list = load();
  const id = randomUUID();
  const rec: SessionRecord = {
    id,
    issuedAt: now,
    lastSeen: now,
    label: label.slice(0, 80),
    ip: ip.slice(0, 64),
  };
  const limit = maxSessions();
  if (limit > 0 && list.length >= limit) {
    // Over (or at) the cap: evict the least-recently-active EXISTING sessions to
    // make room, but ALWAYS keep the one we're creating now. The old code sorted
    // ALL sessions (new included) by lastSeen and kept the top N — so a still-
    // active OTHER device (its lastSeen is also ≈now, often fresher) would evict
    // this brand-new login, handing the user a cookie for a session that doesn't
    // exist in the registry. That locked them out the instant they signed in
    // (every privileged request 401s, /dashboard ping-pongs to /login). Keep the
    // newest device explicitly; with limit 1 this means "new device drops old".
    const keepOthers = list
      .slice()
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, Math.max(0, limit - 1));
    mem = [...keepOthers, rec];
  } else {
    list.push(rec);
    mem = list;
  }
  persist(true);
  return id;
}

/** Validate a session id and refresh its activity (rolling idle timeout). False
 *  if unknown/expired. This is the per-request check the door calls. */
export function validateSession(id: string): boolean {
  if (!id) return false;
  const now = Date.now();
  const list = load();
  const rec = list.find((r) => r.id === id);
  if (!rec) return false;
  if (expired(rec, now)) {
    mem = list.filter((r) => r.id !== id);
    persist(true);
    return false;
  }
  rec.lastSeen = now;
  persist(); // throttled
  return true;
}

/** Remove one session (operator "drop this device", or self sign-out). */
export function revokeSession(id: string): void {
  const list = load();
  const next = list.filter((r) => r.id !== id);
  if (next.length !== list.length) {
    mem = next;
    persist(true);
  }
}

/** Remove every session EXCEPT the given one ("sign out other devices"). */
export function revokeOthers(keepId: string): void {
  const list = load();
  const next = list.filter((r) => r.id === keepId);
  if (next.length !== list.length) {
    mem = next;
    persist(true);
  }
}

/** Wipe the whole registry (used alongside a sign-out-everywhere epoch bump). */
export function clearSessions(): void {
  mem = [];
  persist(true);
}

export interface SessionView {
  id: string;
  label: string;
  ip: string;
  issuedAt: number;
  lastSeen: number;
  current: boolean;
}

/** Sanitized list for the Settings UI, newest activity first. */
export function listSessions(currentId: string | null): SessionView[] {
  prune(Date.now());
  return load()
    .slice()
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((r) => ({
      id: r.id,
      label: r.label || 'Unknown device',
      ip: r.ip,
      issuedAt: r.issuedAt,
      lastSeen: r.lastSeen,
      current: r.id === currentId,
    }));
}

/** A short device label from a User-Agent string (browser + OS, no specifics). */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}
