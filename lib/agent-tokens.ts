// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: bearer tokens for EXTERNAL agents (Claude Code / Codex on the
// owner's desktops) calling the lab tools over the LAN-only MCP endpoint
// (app/api/agent/mcp/route.ts).
//
// One token per desktop/agent so each can be revoked on its own. Minted from
// Settings behind a fresh password + TOTP re-auth, shown ONCE, and stored here
// only as a SHA-256 hash (the tokens are 256-bit random, so a plain hash is the
// right primitive — no salt/KDF needed). The browser never sees a token again
// after minting; no route can read one back.
//
// Persisted to data/agent-tokens.json via writeFileAtomic, re-read on mtime
// change (multi-instance — same pattern as lib/session-store.ts).
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFileAtomic } from '@/lib/atomic-write';

export interface AgentTokenRecord {
  id: string;
  /** Operator label, e.g. "desktop / Claude Code". */
  name: string;
  /** SHA-256 hex of the token. */
  hash: string;
  /** First chars of the token, so the operator can tell which one is which. */
  prefix: string;
  createdAt: number;
  lastUsed: number | null;
}

/** What the Settings list sees — never the hash. */
export type AgentTokenView = Omit<AgentTokenRecord, 'hash'>;

const FILE = path.join(process.cwd(), 'data', 'agent-tokens.json');
const TOKEN_PREFIX = 'glab_';
const MAX_TOKENS = 20;
const LAST_USED_PERSIST_MS = 60_000; // throttle lastUsed writes

let mem: AgentTokenRecord[] | null = null;
let memMtime = -1;
let lastPersist = 0;

function fileMtimeMs(): number {
  try {
    return fs.statSync(FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function load(): AgentTokenRecord[] {
  const mtime = fileMtimeMs();
  if (mem && mtime === memMtime) return mem;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    mem = Array.isArray(raw)
      ? (raw as AgentTokenRecord[]).filter(
          (r) => r && typeof r.id === 'string' && typeof r.hash === 'string' && r.hash.length === 64,
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
  if (!force && now - lastPersist < LAST_USED_PERSIST_MS) return;
  lastPersist = now;
  try {
    writeFileAtomic(FILE, JSON.stringify(mem ?? [], null, 2));
    memMtime = fileMtimeMs();
  } catch (err) {
    console.error('[agent-tokens] store write failed:', (err as Error)?.message ?? err);
    if (force) throw err;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const view = ({ hash: _hash, ...rest }: AgentTokenRecord): AgentTokenView => rest;

export function listAgentTokens(): AgentTokenView[] {
  return load().map(view);
}

/** Mint a token. Returns the plaintext ONCE (the caller shows it and forgets it). */
export function mintAgentToken(name: string): { token: string; record: AgentTokenView } | { error: string } {
  const list = load();
  if (list.length >= MAX_TOKENS) return { error: `At most ${MAX_TOKENS} agent tokens; revoke one first.` };
  const label = name.trim().replace(/\s+/g, ' ').slice(0, 60) || 'agent';
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const rec: AgentTokenRecord = {
    id: randomUUID(),
    name: label,
    hash: sha256(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    createdAt: Date.now(),
    lastUsed: null,
  };
  mem = [...list, rec];
  persist(true);
  return { token, record: view(rec) };
}

export function revokeAgentToken(id: string): boolean {
  const list = load();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  mem = next;
  persist(true);
  return true;
}

/** Resolve a presented bearer token to its record (and touch lastUsed), or null.
 *  Compares hashes in constant time across every record. */
export function verifyAgentToken(presented: string | null | undefined): AgentTokenView | null {
  if (!presented || !presented.startsWith(TOKEN_PREFIX) || presented.length > 200) return null;
  const want = Buffer.from(sha256(presented), 'hex');
  let hit: AgentTokenRecord | null = null;
  for (const r of load()) {
    const have = Buffer.from(r.hash, 'hex');
    if (have.length === want.length && timingSafeEqual(have, want)) hit = r;
  }
  if (!hit) return null;
  hit.lastUsed = Date.now();
  persist(); // throttled
  return view(hit);
}
