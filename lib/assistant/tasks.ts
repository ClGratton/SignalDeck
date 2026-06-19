// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the agent task registry — the assistant's execution decoupled
// from the HTTP request.
//
// Previously the agent loop ran INSIDE the POST /api/assistant stream, so a
// reload, a closed tab, a dropped Cloudflare tunnel, or a logout aborted the
// turn mid-flight ("stuck on working", a 1-hour timer vanishing on reload).
//
// Now each turn runs as a server-side TASK that owns its own lifecycle:
//   • The loop runs in the background, NOT tied to the request that started it.
//   • Every event is appended to a per-task log (with a sequence number) AND
//     fanned out to any attached subscribers, so a client can detach and
//     reattach (GET /api/assistant/stream?from=seq) and replay what it missed.
//   • Timers are SERVER-side: start_timer ends the turn, the task sleeps, and a
//     scheduled wake-up re-invokes the agent on its own — surviving reload/logout.
//   • One live task per chat ⇒ multiple chats run concurrently.
//   • The task writes its turn into the shared chat store as it goes, so a fully
//     detached operator still sees the result when they come back.
//   • Non-terminal tasks are persisted (data/assistant-tasks.json) so a sleeping
//     timer survives a process restart; a task that was mid-RUN at a crash can't
//     be resumed (you can't serialize a running async fn) and is marked errored.
//
// Same accepted single-instance limit as the login throttle: the live registry
// is per-process. If this ever runs multi-instance, move it to a shared store.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runAnthropicTurn } from '@/lib/assistant/anthropic';
import { runGeminiTurn } from '@/lib/assistant/gemini';
import { runOpenAiTurn } from '@/lib/assistant/openai';
import { getProviderKey, getProviderBaseUrl, providerDef } from '@/lib/assistant/keys';
import { awaitDecision } from '@/lib/assistant/decisions';
import { readChats, writeTaskChat, setLiveTaskGuard, type StoredChatRecord } from '@/lib/assistant/chat-store';
import type { ToolContext } from '@/lib/assistant/tools';
import type {
  ApprovalLevel,
  AssistantEvent,
  AssistantMode,
  AssistantProvider,
  ChatTurn,
  StreamFrame,
  TaskStatus,
  TaskStatusDto,
} from '@/lib/assistant/types';

// ── Projected transcript items (the client's renderable shapes) ──────────────
// The task projects its event stream into these so it can (a) write a turn the
// client can render straight from the chat store, and (b) reconstruct the API
// transcript for a timer resume. Mirrors the client's Item union (the kinds the
// agent produces) — keep field names matching so sanitizeItems accepts them.
type ProjItem =
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; label: string }
  | { kind: 'proposal'; card: unknown; state: string }
  | {
      kind: 'action';
      id: string;
      title: string;
      status: string;
      detail?: string;
      request?: string;
      critical?: boolean;
      reauth?: boolean;
    }
  | { kind: 'timer'; id: string; label: string; endsAt: number; status: string }
  | { kind: 'error'; text: string };

interface TaskRecord {
  id: string;
  chatId: string;
  status: TaskStatus;
  provider: AssistantProvider;
  model: string;
  mode: AssistantMode;
  approval: ApprovalLevel;
  /** The original request transcript (seed for the first run + every resume). */
  turns: ChatTurn[];
  /** Raw user message for the projected `user` item written to the chat store. */
  userText: string;
  /** Chat items that existed BEFORE this turn (captured from the store at start). */
  priorItems: unknown[];
  title: string;
  /** Append-only event log with seq numbers, for reattach/replay. */
  log: StreamFrame[];
  seq: number;
  /** This turn's projected items (assistant side only — no leading user item). */
  items: ProjItem[];
  /** Sleeping tasks: epoch-ms wake time. */
  wakeAt?: number;
  /** Sleeping tasks: the timer being waited on (so the client re-arms exactly
   *  this one, by id, instead of guessing "the last timer item"). */
  activeTimerId?: string;
  activeTimerLabel?: string;
  createdAt: number;
  updatedAt: number;
}

interface LiveTask extends TaskRecord {
  subscribers: Set<(f: StreamFrame) => void>;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  sawError: boolean;
  terminalAt?: number;
}

const MAX_LOG = 2000;
const MAX_ITEMS = 400;
const TERMINAL_RETAIN_MS = 120_000; // keep finished tasks briefly for reattach
const PERSIST_FILE = path.join(process.cwd(), 'data', 'assistant-tasks.json');

const tasks = new Map<string, LiveTask>();

// Let the chat store protect a task-owned chat from a stale client PUT.
setLiveTaskGuard(() => [...tasks.values()].filter((t) => !isTerminal(t.status)).map((t) => t.chatId));

function isTerminal(s: TaskStatus): boolean {
  return s === 'done' || s === 'error';
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

// ── Event log + fan-out ──────────────────────────────────────────────────────

function emit(task: LiveTask, event: AssistantEvent): void {
  if (event.type === 'error') task.sawError = true;
  const frame: StreamFrame = { seq: ++task.seq, event };
  task.log.push(frame);
  if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
  project(task, event);
  task.updatedAt = Date.now();
  for (const sub of task.subscribers) {
    try {
      sub(frame);
    } catch {
      /* a dead subscriber; the stream's cancel() removes it */
    }
  }
}

/** Fold an event into the projected item list (mirrors the client's handler). */
function project(task: LiveTask, e: AssistantEvent): void {
  const items = task.items;
  const last = items[items.length - 1];
  switch (e.type) {
    case 'text':
      if (last?.kind === 'assistant') last.text += e.text;
      else items.push({ kind: 'assistant', text: e.text });
      break;
    case 'reasoning':
      if (last?.kind === 'reasoning') last.text += e.text;
      else items.push({ kind: 'reasoning', text: e.text });
      break;
    case 'tool':
      items.push({ kind: 'tool', label: e.label });
      break;
    case 'proposal':
      items.push({ kind: 'proposal', card: e.proposal, state: 'pending' });
      break;
    case 'confirm':
      items.push({
        kind: 'action',
        id: e.card.id,
        title: e.card.title,
        status: 'pending',
        critical: e.critical,
        request: e.card.detail,
      });
      break;
    case 'reauth':
      items.push({
        kind: 'action',
        id: e.card.id,
        title: e.card.title,
        status: 'pending',
        reauth: true,
        request: e.card.detail,
      });
      break;
    case 'action': {
      const idx = items.findIndex((it) => it.kind === 'action' && it.id === e.id);
      const prior = idx >= 0 ? (items[idx] as Extract<ProjItem, { kind: 'action' }>) : undefined;
      const row: ProjItem = {
        kind: 'action',
        id: e.id,
        title: e.title,
        status: e.status,
        detail: e.detail,
        request: e.request ?? prior?.request,
        critical: prior?.critical,
        reauth: prior?.reauth,
      };
      if (idx >= 0) items[idx] = row;
      else items.push(row);
      break;
    }
    case 'timer':
      items.push({
        kind: 'timer',
        id: e.id,
        label: e.label,
        endsAt: e.until ?? Date.now() + e.seconds * 1000,
        status: 'running',
      });
      break;
    case 'error':
      items.push({ kind: 'error', text: e.message });
      break;
    default:
      break; // sleep / done / workspace produce no transcript item
  }
  if (items.length > MAX_ITEMS) items.splice(0, items.length - MAX_ITEMS);
}

// ── API transcript reconstruction (for a timer resume) ───────────────────────
// Mirrors the client's buildHistory for the kinds the agent produces, so a
// resumed turn carries the same execution memory the client would have re-sent.

function mergeConsecutive(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of turns) {
    const lastT = out[out.length - 1];
    if (lastT && lastT.role === t.role) lastT.content += '\n' + t.content;
    else out.push({ ...t });
  }
  return out;
}

function turnsFromItems(items: ProjItem[]): ChatTurn[] {
  const raw: ChatTurn[] = [];
  for (const it of items) {
    if (it.kind === 'assistant' && it.text) raw.push({ role: 'assistant', content: it.text });
    else if (it.kind === 'action' && (it.status === 'ok' || it.status === 'fail' || it.status === 'skipped')) {
      const head =
        it.status === 'skipped'
          ? `operator skipped "${it.title}" (did not run)`
          : it.status === 'fail'
            ? `"${it.title}" FAILED`
            : `"${it.title}" ran`;
      const parts = [head];
      if (it.request) parts.push(`sent ${clip(it.request, 300)}`);
      if (it.detail) parts.push(`result: ${clip(it.detail, 1500)}`);
      raw.push({ role: 'user', content: `(tool result — ${parts.join('; ')})` });
    } else if (it.kind === 'tool') {
      raw.push({ role: 'user', content: `(tool result — looked up: ${it.label})` });
    } else if (it.kind === 'timer' && it.status !== 'running') {
      raw.push({
        role: 'user',
        content:
          it.status === 'stopped'
            ? `(operator STOPPED the "${it.label}" timer — do NOT start another timer for this unless they explicitly ask again)`
            : `(waited for: ${it.label})`,
      });
    }
  }
  return raw;
}

// ── Chat-store write (so a detached operator still sees the turn) ─────────────

function writeTurn(task: LiveTask): void {
  const items = [
    ...task.priorItems,
    { kind: 'user', text: task.userText },
    ...task.items,
  ];
  const rec: StoredChatRecord = {
    id: task.chatId,
    title: task.title || task.userText.slice(0, 60) || 'New chat',
    createdAt: task.createdAt,
    updatedAt: Date.now(),
    items,
  };
  try {
    writeTaskChat(rec);
  } catch {
    /* disk hiccup — the in-memory log still drives any attached client */
  }
}

// ── Provider dispatch ────────────────────────────────────────────────────────

async function runProvider(task: LiveTask, turns: ChatTurn[], ctx: ToolContext): Promise<void> {
  const key = getProviderKey(task.provider);
  if (!key) {
    emit(task, { type: 'error', message: 'No API key configured for this provider.' });
    return;
  }
  const kind = providerDef(task.provider)?.kind;
  if (kind === 'anthropic') {
    await runAnthropicTurn(key, task.model, turns, ctx);
  } else if (kind === 'gemini') {
    await runGeminiTurn(key, task.model, turns, ctx);
  } else {
    const base = getProviderBaseUrl(task.provider);
    if (!base) {
      emit(task, { type: 'error', message: `No base URL configured for ${task.provider}.` });
      return;
    }
    await runOpenAiTurn(task.provider, key, base, task.model, turns, ctx);
  }
}

function makeCtx(task: LiveTask): ToolContext {
  return {
    mode: task.mode,
    approval: task.approval,
    emit: (e) => emit(task, e),
    awaitDecision: (id, signal) => awaitDecision(id, signal),
    signal: task.abort.signal,
    chatId: task.chatId,
    sleep: undefined,
  };
}

/** Run one segment of the turn (initial or post-timer resume). Not awaited by
 *  the caller — it owns the task's progression to sleep / done / error. */
async function drive(task: LiveTask, turns: ChatTurn[]): Promise<void> {
  task.status = 'running';
  task.sawError = false;
  task.wakeAt = undefined;
  task.activeTimerId = undefined;
  task.activeTimerLabel = undefined;
  const ctx = makeCtx(task);
  try {
    await runProvider(task, turns, ctx);
  } catch (err) {
    if (!task.abort.signal.aborted) {
      console.error('[assistant] task failed:', (err as Error)?.message ?? err);
      emit(task, { type: 'error', message: 'The assistant request failed. Try again.' });
    }
  }

  if (task.abort.signal.aborted) {
    // Explicit Stop: emit a terminal frame so attached streams close, then settle.
    emit(task, { type: 'error', message: 'Stopped.' });
    finalize(task, 'error');
    return;
  }
  if (ctx.sleep) {
    scheduleSleep(task, ctx.sleep);
    return;
  }
  if (task.sawError) {
    finalize(task, 'error');
    return;
  }
  emit(task, { type: 'done' });
  finalize(task, 'done');
}

function scheduleSleep(task: LiveTask, sleep: { seconds: number; label: string; id: string }): void {
  task.status = 'sleeping';
  task.wakeAt = Date.now() + sleep.seconds * 1000;
  task.activeTimerId = sleep.id;
  task.activeTimerLabel = sleep.label;
  emit(task, { type: 'sleep', until: task.wakeAt });
  writeTurn(task);
  persist();
  const delay = Math.max(0, task.wakeAt - Date.now());
  task.timer = setTimeout(() => resume(task, sleep.label, sleep.id), delay);
}

function resume(task: LiveTask, label: string, timerId: string): void {
  if (isTerminal(task.status)) return;
  // The countdown elapsed: settle its item to 'done' so the resumed transcript
  // reads "(waited for: …)" rather than a dangling running timer.
  const t = task.items.find((it) => it.kind === 'timer' && it.id === timerId);
  if (t && t.kind === 'timer') t.status = 'done';
  const resumeTurns = mergeConsecutive([
    ...task.turns,
    ...turnsFromItems(task.items),
    { role: 'user', content: `The "${label}" timer elapsed — continue.` },
  ]);
  void drive(task, resumeTurns);
}

function finalize(task: LiveTask, status: TaskStatus): void {
  task.status = status;
  task.terminalAt = Date.now();
  if (task.timer) clearTimeout(task.timer);
  writeTurn(task);
  persist();
  // Retain briefly so a reloading client can still replay the tail, then drop.
  setTimeout(() => {
    const cur = tasks.get(task.chatId);
    if (cur === task && isTerminal(cur.status)) tasks.delete(task.chatId);
  }, TERMINAL_RETAIN_MS);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface StartTaskOpts {
  chatId: string;
  provider: AssistantProvider;
  model: string;
  mode: AssistantMode;
  approval: ApprovalLevel;
  turns: ChatTurn[];
  userText: string;
}

/** Start a new turn for a chat. Refuses if one is already live (the composer is
 *  locked while busy, so this is a guard, not a normal path). */
export function startTask(opts: StartTaskOpts): { ok: true; task: LiveTask } | { ok: false; reason: string } {
  loadOnce();
  const existing = tasks.get(opts.chatId);
  if (existing && !isTerminal(existing.status)) {
    return { ok: false, reason: 'A task is already running for this chat.' };
  }
  // Snapshot the chat's settled items so the turn we write appends to them.
  const stored = readChats().chats.find((c) => c.id === opts.chatId);
  const priorItems = Array.isArray(stored?.items) ? stored!.items : [];
  const now = Date.now();
  const task: LiveTask = {
    id: randomUUID(),
    chatId: opts.chatId,
    status: 'running',
    provider: opts.provider,
    model: opts.model,
    mode: opts.mode,
    approval: opts.approval,
    turns: opts.turns,
    userText: opts.userText,
    priorItems,
    title: stored?.title || opts.userText.slice(0, 60),
    log: [],
    seq: 0,
    items: [],
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
    subscribers: new Set(),
    abort: new AbortController(),
    sawError: false,
  };
  tasks.set(opts.chatId, task);
  writeTurn(task); // persist the user message immediately (survives instant reload)
  void drive(task, opts.turns);
  return { ok: true, task };
}

/** Subscribe a stream to a chat's task: replay everything after `fromSeq`, then
 *  receive live frames. Returns an unsubscribe fn, or null if no task exists. */
export function subscribeTask(
  chatId: string,
  fromSeq: number,
  onFrame: (f: StreamFrame) => void,
): (() => void) | null {
  const task = tasks.get(chatId);
  if (!task) return null;
  // Replay first (single-threaded: no live frame can interleave before we add).
  for (const f of task.log) if (f.seq > fromSeq) onFrame(f);
  task.subscribers.add(onFrame);
  return () => task.subscribers.delete(onFrame);
}

/** True if the task is already finished (so the stream should close after the
 *  replay above instead of hanging). */
export function taskTerminal(chatId: string): boolean {
  const task = tasks.get(chatId);
  return !task || isTerminal(task.status);
}

/** Build an NDJSON stream of a chat's task frames (replay after `fromSeq`, then
 *  live), closing when the turn finishes. Detaching (client disconnect) only
 *  removes the subscriber — the task keeps running. Null if no task to attach. */
export function streamFrames(chatId: string, fromSeq: number): ReadableStream<Uint8Array> | null {
  if (!tasks.has(chatId)) return null;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onFrame = (f: StreamFrame) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(f) + '\n'));
        } catch {
          /* client went away mid-write */
        }
        if (f.event.type === 'done' || f.event.type === 'error') {
          if (unsubscribe) unsubscribe();
          stopHeartbeat();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      unsubscribe = subscribeTask(chatId, fromSeq, onFrame);
      if (!unsubscribe) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }
      // Heartbeat: a bare newline the client skips (its parser ignores blank
      // lines). A long step can be silent for minutes; without periodic bytes a
      // reverse proxy (Cloudflare's ~100s cap) kills the connection → HTTP 524.
      // The task survives a kill, but this keeps the live stream attached.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode('\n'));
        } catch {
          stopHeartbeat();
        }
      }, 20_000);
    },
    cancel() {
      // The reader (client) detached: stop sending frames, but DO NOT abort the
      // task — that's the whole point. It keeps running and is reattachable.
      if (unsubscribe) unsubscribe();
      stopHeartbeat();
    },
  });
}

/** Stop a chat's task (operator pressed Stop / cancelled a timer). */
export function stopTask(chatId: string): boolean {
  const task = tasks.get(chatId);
  if (!task || isTerminal(task.status)) return false;
  // Always cancel a scheduled resume so a stopped timer can't fire later.
  if (task.timer) {
    clearTimeout(task.timer);
    task.timer = undefined;
  }
  if (task.status === 'sleeping') {
    // A SLEEPING task is NOT inside drive() (its turn already returned and is
    // waiting on the timer above). An abort alone would neither settle it nor
    // stop the resume — that's the bug behind "stop a timer, it comes back on
    // reload" and "stuck at working after stop". Settle it HERE: mark the timer
    // cancelled, emit a terminal frame (closes any reattached stream), finalize.
    const t = [...task.items].reverse().find((it) => it.kind === 'timer' && it.status === 'running');
    if (t && t.kind === 'timer') t.status = 'stopped';
    emit(task, { type: 'done' });
    finalize(task, 'done');
  } else {
    task.abort.abort(); // running: drive()'s abort branch finalizes it
  }
  return true;
}

export function liveTaskStatus(chatId: string): TaskStatusDto | null {
  const task = tasks.get(chatId);
  // A terminal task is retained briefly so a reloading client can replay its
  // tail, but it is NOT live — reporting it as such would leave a stale "working"
  // dot and re-lock the composer for a finished turn. Treat terminal as absent.
  if (!task || isTerminal(task.status)) return null;
  return {
    chatId,
    status: task.status,
    seq: task.seq,
    wakeAt: task.wakeAt,
    timerId: task.activeTimerId,
    timerLabel: task.activeTimerLabel,
  };
}

export function liveTaskStatuses(): TaskStatusDto[] {
  return [...tasks.values()]
    .filter((t) => !isTerminal(t.status)) // exclude retained-but-finished tasks
    .map((t) => ({
      chatId: t.chatId,
      status: t.status,
      seq: t.seq,
      wakeAt: t.wakeAt,
      timerId: t.activeTimerId,
      timerLabel: t.activeTimerLabel,
    }));
}

// ── Persistence (best-effort; resumes sleeping timers across a restart) ──────

interface PersistedTask {
  id: string;
  chatId: string;
  status: TaskStatus;
  provider: AssistantProvider;
  model: string;
  mode: AssistantMode;
  approval: ApprovalLevel;
  turns: ChatTurn[];
  userText: string;
  priorItems: unknown[];
  title: string;
  items: ProjItem[];
  seq: number;
  wakeAt?: number;
  createdAt: number;
}

let persistScheduled = false;
function persist(): void {
  if (persistScheduled) return;
  persistScheduled = true;
  setTimeout(() => {
    persistScheduled = false;
    const out: PersistedTask[] = [];
    for (const t of tasks.values()) {
      if (isTerminal(t.status)) continue; // terminal turns already wrote to the chat store
      out.push({
        id: t.id,
        chatId: t.chatId,
        status: t.status,
        provider: t.provider,
        model: t.model,
        mode: t.mode,
        approval: t.approval,
        turns: t.turns,
        userText: t.userText,
        priorItems: t.priorItems,
        title: t.title,
        items: t.items,
        seq: t.seq,
        wakeAt: t.wakeAt,
        createdAt: t.createdAt,
      });
    }
    try {
      fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(out), 'utf8');
    } catch {
      /* best-effort */
    }
  }, 200);
}

let loaded = false;
function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  let saved: PersistedTask[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8')) as unknown;
    if (Array.isArray(raw)) saved = raw as PersistedTask[];
  } catch {
    return; // no/again corrupt persisted state — nothing to restore
  }
  for (const p of saved) {
    if (!p || typeof p.chatId !== 'string' || tasks.has(p.chatId)) continue;
    const now = Date.now();
    const task: LiveTask = {
      id: p.id ?? randomUUID(),
      chatId: p.chatId,
      status: p.status,
      provider: p.provider,
      model: p.model,
      mode: p.mode,
      approval: p.approval,
      turns: Array.isArray(p.turns) ? p.turns : [],
      userText: typeof p.userText === 'string' ? p.userText : '',
      priorItems: Array.isArray(p.priorItems) ? p.priorItems : [],
      title: p.title ?? '',
      log: [],
      seq: typeof p.seq === 'number' ? p.seq : 0,
      items: Array.isArray(p.items) ? p.items : [],
      wakeAt: p.wakeAt,
      createdAt: p.createdAt ?? now,
      updatedAt: now,
      subscribers: new Set(),
      abort: new AbortController(),
      sawError: false,
    };
    if (p.status === 'sleeping' && typeof p.wakeAt === 'number') {
      // Reschedule the wait; if it already passed during downtime, fire soon.
      tasks.set(task.chatId, task);
      const lastTimer = [...task.items].reverse().find((it) => it.kind === 'timer');
      const label = lastTimer && lastTimer.kind === 'timer' ? lastTimer.label : 'waiting';
      const id = lastTimer && lastTimer.kind === 'timer' ? lastTimer.id : randomUUID();
      task.activeTimerId = id;
      task.activeTimerLabel = label;
      const delay = Math.max(0, task.wakeAt! - now);
      task.timer = setTimeout(() => resume(task, label, id), delay);
    } else {
      // running/awaiting can't be resumed (the in-flight fn is gone) — record
      // the interruption in the chat store so the operator isn't left hanging.
      tasks.set(task.chatId, task);
      emit(task, { type: 'error', message: 'Interrupted by a server restart — ask again to continue.' });
      finalize(task, 'error');
    }
  }
}

// Restore on module load (idempotent) so a sleeping timer resumes after a deploy.
loadOnce();
