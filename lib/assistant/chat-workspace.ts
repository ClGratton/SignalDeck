// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: each chat's scratch WORKSPACE — short notes + an optional plan.
//
// This is the CHAT-SCOPED counterpart to global memory (lib/assistant/memory.ts).
// Global memory holds durable lab facts that outlive a chat; this holds things
// that only matter to ONE conversation: one-off task intent, ids discovered for
// the task at hand, and a multi-step plan/checklist the assistant builds for a
// long request. Keyed by chatId, stored in data/assistant-workspace.json
// (gitignored runtime state). Operator-visible; never store secrets.
//
// Kept separate from the chat transcript store (chat-store.ts) on purpose: that
// store is owned/overwritten wholesale by the client, while this is mutated by
// the assistant's tools server-side. Different writers → different files.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@/lib/atomic-write';
import { randomUUID } from 'node:crypto';
import type {
  ChatNoteDto,
  ChatWorkspaceDto,
  PlanStepDto,
  PlanStepStatus,
} from '@/lib/assistant/types';

interface Workspace extends ChatWorkspaceDto {
  updatedAt: number;
}
type Store = Record<string, Workspace>;

const FILE = path.join(process.cwd(), 'data', 'assistant-workspace.json');
const MAX_WORKSPACES = 80; // LRU cap across chats
const MAX_NOTES = 30;
const MAX_STEPS = 25;
const NOTE_CHARS = 300;
const STEP_CHARS = 160;

let cached: Store | null = null;
let cachedMtime = -1; // re-read on mtime change (multi-instance — see chat-store.ts)

function fileMtimeMs(): number {
  try {
    return fs.statSync(FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function read(): Store {
  const mtime = fileMtimeMs();
  if (cached && mtime === cachedMtime) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    cached = raw && typeof raw === 'object' ? (raw as Store) : {};
  } catch {
    cached = {};
  }
  cachedMtime = mtime;
  return cached;
}

function write(store: Store): void {
  cached = store;
  try {
    writeFileAtomic(FILE, JSON.stringify(store, null, 2));
    cachedMtime = fileMtimeMs();
  } catch {
    /* best-effort; the in-memory cache still holds it */
  }
}

const emptyWs = (): Workspace => ({ notes: [], plan: [], updatedAt: Date.now() });

/** The chat's workspace as a plain DTO (empty when it has none). */
export function getWorkspace(chatId: string): ChatWorkspaceDto {
  const ws = read()[chatId] ?? emptyWs();
  return { notes: ws.notes, plan: ws.plan };
}

/** Load, mutate, prune to the LRU cap, persist, and return the fresh DTO. */
function mutate(chatId: string, fn: (ws: Workspace) => void): ChatWorkspaceDto {
  const store = { ...read() };
  const ws: Workspace = store[chatId]
    ? { ...store[chatId], notes: [...store[chatId].notes], plan: [...store[chatId].plan] }
    : emptyWs();
  fn(ws);
  ws.updatedAt = Date.now();
  store[chatId] = ws;

  const ids = Object.keys(store);
  if (ids.length > MAX_WORKSPACES) {
    ids
      .sort((a, b) => store[a].updatedAt - store[b].updatedAt)
      .slice(0, ids.length - MAX_WORKSPACES)
      .forEach((id) => delete store[id]);
  }
  write(store);
  return { notes: ws.notes, plan: ws.plan };
}

/** Resolve a full id or a short prefix (the prompt shows 8-char ids). */
const byIdOrPrefix = <T extends { id: string }>(arr: T[], k: string): T | undefined =>
  arr.find((x) => x.id === k) ?? arr.find((x) => x.id.startsWith(k));

export function addChatNote(chatId: string, text: string): { ok: boolean; detail: string; workspace: ChatWorkspaceDto } {
  const trimmed = text.trim().slice(0, NOTE_CHARS);
  if (trimmed.length < 2) return { ok: false, detail: 'Note is empty.', workspace: getWorkspace(chatId) };
  let detail = 'Noted for this chat.';
  const workspace = mutate(chatId, (ws) => {
    if (ws.notes.some((n) => n.text.toLowerCase() === trimmed.toLowerCase())) {
      detail = 'An identical note already exists.';
      return;
    }
    if (ws.notes.length >= MAX_NOTES) ws.notes.shift(); // drop the oldest
    ws.notes.push({ id: randomUUID(), text: trimmed });
  });
  return { ok: true, detail, workspace };
}

export function removeChatNote(chatId: string, idOrPrefix: string): { ok: boolean; workspace: ChatWorkspaceDto } {
  let ok = false;
  const workspace = mutate(chatId, (ws) => {
    const target = byIdOrPrefix(ws.notes, idOrPrefix);
    if (target) {
      ws.notes = ws.notes.filter((n) => n.id !== target.id);
      ok = true;
    }
  });
  return { ok, workspace };
}

/** Replace the whole plan with a fresh checklist (all steps start 'todo'). */
export function setPlan(chatId: string, steps: string[]): { ok: boolean; detail: string; workspace: ChatWorkspaceDto } {
  const clean = steps
    .map((s) => (typeof s === 'string' ? s.trim().slice(0, STEP_CHARS) : ''))
    .filter((s) => s.length > 0)
    .slice(0, MAX_STEPS);
  const workspace = mutate(chatId, (ws) => {
    ws.plan = clean.map((text): PlanStepDto => ({ id: randomUUID(), text, status: 'todo' }));
  });
  return {
    ok: true,
    detail: clean.length ? `Plan set (${clean.length} steps).` : 'Plan cleared.',
    workspace,
  };
}

/** Mark a step (by 1-based number or id) done/doing/todo. */
export function updatePlanStep(
  chatId: string,
  ref: string,
  status: PlanStepStatus,
): { ok: boolean; detail: string; workspace: ChatWorkspaceDto } {
  let detail = 'No matching plan step.';
  let ok = false;
  const workspace = mutate(chatId, (ws) => {
    const n = Number(ref);
    const target =
      Number.isInteger(n) && n >= 1 && n <= ws.plan.length
        ? ws.plan[n - 1]
        : byIdOrPrefix(ws.plan, ref);
    if (!target) return;
    ws.plan = ws.plan.map((s) => (s.id === target.id ? { ...s, status } : s));
    ok = true;
    detail = `Step "${target.text.slice(0, 40)}" → ${status}.`;
  });
  return { ok, detail, workspace };
}

/** Clear notes and/or plan (operator action via the workspace route). */
export function clearWorkspace(chatId: string, what: 'notes' | 'plan' | 'all'): ChatWorkspaceDto {
  return mutate(chatId, (ws) => {
    if (what === 'notes' || what === 'all') ws.notes = [];
    if (what === 'plan' || what === 'all') ws.plan = [];
  });
}

/** The block injected into the system prompt (empty when nothing is stored). The
 *  [id] prefixes let the model target notes/steps with the workspace tools. */
export function workspacePromptBlock(chatId: string): string {
  const ws = getWorkspace(chatId);
  if (ws.notes.length === 0 && ws.plan.length === 0) return '';
  const parts: string[] = ['\n\nThis chat only (scratch — not global memory):'];
  if (ws.notes.length > 0) {
    parts.push(
      'Chat notes:\n' + ws.notes.map((n: ChatNoteDto) => `- [${n.id.slice(0, 8)}] ${n.text}`).join('\n'),
    );
  }
  if (ws.plan.length > 0) {
    const mark = { todo: '[ ]', doing: '[~]', done: '[x]' } as const;
    parts.push(
      'Current plan (update steps with plan_update as you go):\n' +
        ws.plan
          .map((s: PlanStepDto, i) => `${i + 1}. ${mark[s.status]} [${s.id.slice(0, 8)}] ${s.text}`)
          .join('\n'),
    );
  }
  return parts.join('\n');
}
