// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the operator assistant's chat history, centralized server-side.
//
// Previously each browser kept its own copy in localStorage, so the same person
// saw different chats in the preview vs. their phone vs. another tab. This is the
// single source of truth instead: one shared collection (the dashboard is a
// single-user gate), stored in data/assistant-chats.json (gitignored runtime
// state). Served and written ONLY through the session-gated /api/assistant/chats
// route — the transcripts hold rich operator data (guest names, datasets, action
// results) that the public aggregates deliberately omit.
//
// The store is intentionally schema-light: it validates the envelope (chat id /
// title / timestamps) and caps sizes, but treats each chat's `items` array as
// opaque so the client's rich transcript shape can evolve without a server
// change. Never store secrets here — the assistant's prompts forbid putting
// tokens in transcripts, and key values never reach the browser to begin with.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@/lib/atomic-write';

export interface StoredChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Opaque to the server: the client's discriminated-union transcript items. */
  items: unknown[];
}

export interface ChatCollection {
  activeId: string | null;
  chats: StoredChatRecord[];
}

const FILE = path.join(process.cwd(), 'data', 'assistant-chats.json');
const MAX_CHATS = 50;
// Keep the whole transcript so the operator can scroll to the start of a long
// agent run (matches the client's MAX_ITEMS). The JSON size guard below is the
// real runaway-growth backstop.
const MAX_ITEMS_PER_CHAT = 1000;
// A guard against a runaway client filling the disk — not a hard product limit.
const MAX_JSON_CHARS = 4_000_000;

let cached: ChatCollection | null = null;
// Mtime of the file backing `cached`. MUST NOT be a permanent cache: this deploy
// is multi-instance (see CLAUDE.md), and a chat the agent TASK advances on one
// worker is invisible to a `readChats()` on another worker if it serves a frozen
// `cached` — the symptom was "I worked on this chat from another PC, came back,
// and the transcript is stuck 33h ago while the task is still running." Re-read on
// mtime change so every worker (and the live-task clobber guard below, which
// reads `prior` here) sees the one true file. The atomic write makes the re-read
// safe — a reader never catches a half-written file.
let cachedMtime = -1;

function fileMtimeMs(): number {
  try {
    return fs.statSync(FILE).mtimeMs;
  } catch {
    return 0;
  }
}

// A chat with a LIVE server-side agent task is owned by the task runner, which
// writes that chat's in-progress turn as it goes. A client PUT sends the WHOLE
// collection and may carry a stale copy of that chat (it detached mid-turn), so
// we must not let it overwrite the server's version. The tasks module injects
// this predicate on load (kept as a hook to avoid a chat-store → tasks import
// cycle); default = nothing is task-owned.
let liveTaskChatIds: () => string[] = () => [];
export function setLiveTaskGuard(fn: () => string[]): void {
  liveTaskChatIds = fn;
}

/** Validate the envelope, cap sizes, keep `items` opaque. Never throws. */
function coerce(raw: unknown): ChatCollection {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawChats = Array.isArray(obj.chats) ? obj.chats : [];
  const chats: StoredChatRecord[] = [];
  for (const c of rawChats) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    if (typeof rec.id !== 'string') continue;
    const now = Date.now();
    chats.push({
      id: rec.id,
      title: typeof rec.title === 'string' ? rec.title.slice(0, 80) : '',
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : now,
      updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : now,
      items: Array.isArray(rec.items) ? rec.items.slice(-MAX_ITEMS_PER_CHAT) : [],
    });
  }
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmed = chats.slice(0, MAX_CHATS);
  const activeId =
    typeof obj.activeId === 'string' && trimmed.some((c) => c.id === obj.activeId)
      ? obj.activeId
      : (trimmed[0]?.id ?? null);
  return { activeId, chats: trimmed };
}

export function readChats(): ChatCollection {
  const mtime = fileMtimeMs();
  if (cached && mtime === cachedMtime) return cached;
  try {
    cached = coerce(JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown);
  } catch {
    cached = { activeId: null, chats: [] };
  }
  cachedMtime = mtime;
  return cached;
}

export function writeChats(input: unknown): { ok: boolean; detail: string } {
  const coll = coerce(input);
  // Preserve any task-owned chat from the current store: the live turn the task
  // is writing wins over whatever the client just PUT (which may be stale).
  const owned = new Set(liveTaskChatIds());
  if (owned.size > 0) {
    const prior = cached ?? readChats();
    for (const id of owned) {
      const keep = prior.chats.find((c) => c.id === id);
      if (!keep) continue;
      const idx = coll.chats.findIndex((c) => c.id === id);
      if (idx >= 0) coll.chats[idx] = keep;
      else coll.chats.push(keep);
    }
    coll.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return persistCollection(coll);
}

function persistCollection(coll: ChatCollection): { ok: boolean; detail: string } {
  const json = JSON.stringify(coll, null, 2);
  if (json.length > MAX_JSON_CHARS) {
    return { ok: false, detail: 'Chat history exceeds the size limit.' };
  }
  // Cache regardless, so an in-memory write survives a transient disk failure.
  cached = coll;
  try {
    writeFileAtomic(FILE, json);
    cachedMtime = fileMtimeMs(); // our cache matches disk; don't re-read our own write
    return { ok: true, detail: 'Saved.' };
  } catch {
    return { ok: false, detail: 'Could not persist chats to disk.' };
  }
}

/** Server-side write of ONE chat (used by the task runner to persist a turn it
 *  owns). Replaces/inserts just that chat and BYPASSES the live-task guard — the
 *  task is the legitimate owner here, so its in-progress write must land. */
export function writeTaskChat(rec: StoredChatRecord): { ok: boolean; detail: string } {
  const prior = cached ?? readChats();
  const others = prior.chats.filter((c) => c.id !== rec.id);
  const coll = coerce({ activeId: prior.activeId, chats: [rec, ...others] });
  return persistCollection(coll);
}
