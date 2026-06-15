'use client';

// The operator assistant: a collapsible chat wired to /api/assistant (NDJSON
// stream). Read access is automatic; ACTIONS only ever appear as confirmation
// cards — nothing executes until the operator clicks Confirm, and Ask mode
// removes the action tools entirely.
//
// v2: chats persist in localStorage (with a chat list + new chat), the model
// is switchable per provider (live lists from /api/assistant/models; API keys
// are added write-only through /api/assistant/keys and never come back), the
// Ask/Agent mode lives under the model picker, and the assistant's durable
// memory notes are listed and editable in the Memory view.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ListChecks,
  Clock,
  Eye,
  History,
  KeyRound,
  Plus,
  Send,
  Square,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ActionStatus,
  ApprovalLevel,
  AssistantEvent,
  AssistantMode,
  AssistantProvider,
  ChatTurn,
  ChatWorkspaceDto,
  MemoryNoteDto,
  ModelsResponse,
  ProposalCard,
  StreamFrame,
  TaskStatusDto,
} from '@/lib/assistant/types';
import { useReveal } from './RevealProvider';
import { Markdown } from './Markdown';
import styles from './assistant.module.css';

type ProposalState = 'pending' | 'running' | 'ok' | 'fail' | 'gone';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; label: string }
  // Ask-mode proposal (confirmed out of band via /execute).
  | { kind: 'proposal'; card: ProposalCard; state: ProposalState; result?: string }
  // Agent-mode inline action (auto-run, or Run/Skip via /decide).
  | { kind: 'action'; id: string; title: string; status: ActionStatus; critical?: boolean; reauth?: boolean; detail?: string; request?: string }
  // A countdown the model set before waiting; ticks client-side and auto-resumes
  // the assistant when it elapses, unless the operator pauses it.
  | { kind: 'timer'; id: string; label: string; endsAt: number; status: 'running' | 'done' | 'stopped' }
  // A /compact marker: the full transcript above STAYS VISIBLE, but everything
  // before this point is sent to the model as `summary` only. Display vs context.
  | { kind: 'compaction'; summary: string }
  | { kind: 'error'; text: string };

interface StoredChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: Item[];
}

const SUGGESTIONS = ['What is running right now?', 'How full is storage?', 'Anyone watching media?'];

const CHATS_KEY = 'grtlabs:assistant-chats:v1';
const PICK_KEY = 'grtlabs:assistant-pick:v1';
const MRU_KEY = 'grtlabs:assistant-mru:v1';
const MRU_MAX = 3; // how many recently-used models lead the menu per provider
const MODE_KEY = 'grtlabs:assistant-mode';
const APPROVAL_KEY = 'grtlabs:assistant-approval';
const LEGACY_ACTIONS_KEY = 'grtlabs:assistant-actions';
const MAX_CHATS = 30;
const MAX_ITEMS = 300;
// Default target for /compact when no percentage is given.
const DEFAULT_COMPACT_PCT = 25;

// Approximate context window (tokens) per provider/model — drives the usage
// wheel only, so a coarse map is fine. Falls back to a conservative 128k.
function contextWindowFor(provider: AssistantProvider, model: string): number {
  const m = (model || '').toLowerCase();
  switch (provider) {
    case 'anthropic':
      return 200_000;
    case 'gemini':
      return 1_000_000;
    case 'openai':
      return m.includes('gpt-4.1') || m.startsWith('o1') || m.startsWith('o3') ? 200_000 : 128_000;
    default:
      return 128_000; // deepseek, glm, and unknowns
  }
}

const APPROVALS: { id: ApprovalLevel; label: string; hint: string }[] = [
  { id: 'all', label: 'Confirm all', hint: 'Every action waits for your one-click yes.' },
  { id: 'critical', label: 'Critical only', hint: 'Safe actions run; destructive ones ask first.' },
  { id: 'auto', label: 'Autonomous', hint: 'Runs everything on its own. No gate — be careful.' },
];

const newId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
};

const timeAgo = (ts: number) => {
  const m = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/** Re-hydrate persisted items; pending proposals died with their server closure. */
function sanitizeItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  const out: Item[] = [];
  for (const it of raw as Item[]) {
    if (!it || typeof it !== 'object') continue;
    if (it.kind === 'user' || it.kind === 'assistant' || it.kind === 'error') {
      if (typeof it.text === 'string') out.push({ kind: it.kind, text: it.text });
    } else if (it.kind === 'reasoning') {
      if (typeof it.text === 'string') out.push({ kind: 'reasoning', text: it.text });
    } else if (it.kind === 'tool') {
      if (typeof it.label === 'string') out.push({ kind: 'tool', label: it.label });
    } else if (it.kind === 'proposal' && it.card) {
      const stale = it.state === 'pending' || it.state === 'running';
      out.push({
        kind: 'proposal',
        card: it.card,
        state: stale ? 'gone' : it.state,
        result: stale ? 'Expired.' : it.result,
      });
    } else if (it.kind === 'action' && typeof it.id === 'string') {
      // A pending/running action didn't survive the reload — its turn is gone.
      const stale = it.status === 'pending' || it.status === 'running';
      out.push({
        kind: 'action',
        id: it.id,
        title: it.title,
        status: stale ? 'skipped' : it.status,
        detail: stale ? 'Interrupted.' : it.detail,
        request: it.request,
      });
    } else if (it.kind === 'timer' && typeof it.id === 'string') {
      // A timer that was still counting when we left never gets to auto-resume
      // on reload (that would fire stale resumes) — settle it as stopped.
      out.push({
        kind: 'timer',
        id: it.id,
        label: typeof it.label === 'string' ? it.label : 'waiting',
        endsAt: typeof it.endsAt === 'number' ? it.endsAt : Date.now(),
        status: it.status === 'done' ? 'done' : 'stopped',
      });
    } else if (it.kind === 'compaction') {
      // Keep the marker so the context stays compacted across reloads (the brief
      // lives in the item; the full transcript above is still shown).
      if (typeof it.summary === 'string') out.push({ kind: 'compaction', summary: it.summary });
    }
  }
  return out.slice(-MAX_ITEMS);
}

/** Union two chat collections by id, newer updatedAt winning. Used to reconcile
 *  the same-browser localStorage cache with the server's shared copy on load —
 *  and to migrate chats from the old localStorage-only build the first time. */
function mergeChats(a: StoredChat[], b: StoredChat[]): StoredChat[] {
  const byId = new Map<string, StoredChat>();
  for (const c of [...a, ...b]) {
    const prev = byId.get(c.id);
    if (!prev || c.updatedAt > prev.updatedAt) byId.set(c.id, c);
  }
  return [...byId.values()].sort((x, y) => y.updatedAt - x.updatedAt).slice(0, MAX_CHATS);
}

const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** A run of consecutive tool-lookup chips, folded into one collapsible row so a
 *  step that reads the registry seven times doesn't spray seven chips. */
type ToolGroup = { kind: 'toolgroup'; labels: string[] };
type Row = Item | ToolGroup;

function groupRows(items: Item[]): Row[] {
  const rows: Row[] = [];
  let run: string[] | null = null;
  for (const it of items) {
    if (it.kind === 'tool') {
      (run ??= []).push(it.label);
    } else if (it.kind === 'reasoning' && !it.text.trim()) {
      // A blank reasoning item renders as nothing — don't let it break (or
      // appear between) a run of lookups, which is exactly what made seven
      // back-to-back "listed HA entities" chips show separately.
      continue;
    } else {
      if (run) {
        rows.push({ kind: 'toolgroup', labels: run });
        run = null;
      }
      rows.push(it);
    }
  }
  if (run) rows.push({ kind: 'toolgroup', labels: run });
  return rows;
}

/** Collapse consecutive same-role turns — the chat APIs require alternating
 *  user/assistant roles, and the packed tool results below produce runs of user
 *  turns. */
function mergeConsecutive(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += '\n' + t.content;
    else out.push({ ...t });
  }
  return out;
}

/** Build the API transcript from the rich item list. Crucially this PACKS the
 *  outcomes of tool calls and actions back into the context so the model keeps
 *  its execution memory (the chat APIs are stateless; only this payload exists).
 *
 *  These outcomes are framed as USER-role tool-result turns, NOT assistant text.
 *  That's deliberate: putting "[action ran: …]" in the assistant's OWN voice made
 *  the model imitate the format and write those brackets into its visible replies.
 *  As tool results (the operator/system reporting back), it treats them as input
 *  to act on, not prose to reproduce. */
function buildHistory(items: Item[]): ChatTurn[] {
  let raw: ChatTurn[] = [];
  for (const it of items) {
    if (it.kind === 'compaction') {
      // Everything before this is replaced — in the SENT payload only — by the
      // brief. The transcript above stays on screen; this just shrinks context.
      raw = [
        {
          role: 'user',
          content: `Summary of our conversation so far — continue from this:\n\n${it.summary}`,
        },
      ];
    } else if (it.kind === 'user') raw.push({ role: 'user', content: it.text });
    else if (it.kind === 'assistant' && it.text) raw.push({ role: 'assistant', content: it.text });
    else if (
      it.kind === 'action' &&
      (it.status === 'ok' || it.status === 'fail' || it.status === 'skipped')
    ) {
      const head =
        it.status === 'skipped'
          ? `operator skipped "${it.title}" (did not run)`
          : it.status === 'fail'
            ? `"${it.title}" FAILED`
            : `"${it.title}" ran`;
      const parts = [head];
      if (it.request) parts.push(`sent ${clipText(it.request, 300)}`);
      if (it.detail) parts.push(`result: ${clipText(it.detail, 1500)}`);
      raw.push({ role: 'user', content: `(tool result — ${parts.join('; ')})` });
    } else if (it.kind === 'tool') {
      raw.push({ role: 'user', content: `(tool result — looked up: ${it.label})` });
    } else if (it.kind === 'timer' && it.status !== 'running') {
      raw.push({
        role: 'user',
        content: `(waited for: ${it.label}${it.status === 'stopped' ? ' — paused by operator' : ''})`,
      });
    }
  }
  return mergeConsecutive(raw);
}

export function AssistantSidebar({
  provider: providerHint,
  open,
  onClose,
}: {
  /** Server-rendered hint (env/stored key present); refined via /api/assistant/models. */
  provider: AssistantProvider | null;
  /** Mobile drawer visibility; ignored on desktop (CSS keeps it in the grid). */
  open: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Flips true once the chat collection has loaded/reconciled, so the one-time
  // task-reattach pass can run against the right active chat.
  const [chatsLoaded, setChatsLoaded] = useState(false);
  // Chats with a live server task (running or sleeping) — drives the "working"
  // dot in the chat list. Mirrors serverOwnedRef, which stays the synchronous
  // source of truth for the push gating.
  const [liveChats, setLiveChats] = useState<string[]>([]);
  const [view, setView] = useState<'chat' | 'chats' | 'memory'>('chat');
  // Set when any privileged call returns 401 — the 7-day cookie expired or the
  // auth epoch was bumped. Renders a "sign in again" banner instead of dumping
  // the raw "unauthorized" string into the transcript.
  const [sessionExpired, setSessionExpired] = useState(false);

  // Chats live in a ref (mutated + persisted without re-render churn while
  // streaming); chatList is the snapshot rendered by the chats view.
  const chatsRef = useRef<StoredChat[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const [chatList, setChatList] = useState<StoredChat[]>([]);
  const loadedRef = useRef(false);

  // Model menu state
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [pick, setPick] = useState<{ provider: AssistantProvider; model: string } | null>(null);
  // Recently-used model ids per provider — these lead the menu, bumping the
  // default featured picks into "More models" once you've used 3 others.
  const [mru, setMru] = useState<Partial<Record<AssistantProvider, string[]>>>({});
  const [mode, setMode] = useState<AssistantMode>('agent');
  const [approval, setApproval] = useState<ApprovalLevel>('critical');
  const [menuOpen, setMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState<Partial<Record<AssistantProvider, boolean>>>({});
  const [baseDraft, setBaseDraft] = useState<Partial<Record<AssistantProvider, string>>>({});
  // Revealed key values (held in memory only, never persisted).
  const [shownKey, setShownKey] = useState<Partial<Record<AssistantProvider, string>>>({});
  const reveal = useReveal();
  const [keyDraft, setKeyDraft] = useState<Partial<Record<AssistantProvider, string>>>({});
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  // Memory view state
  const [notes, setNotes] = useState<MemoryNoteDto[] | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  // Per-chat workspace: the assistant's chat-scoped notes + plan/checklist. The
  // server is the source of truth (tools mutate it, the stream pushes updates);
  // we fetch it when switching chats and clear it for a fresh chat.
  const [workspace, setWorkspace] = useState<ChatWorkspaceDto | null>(null);
  const [planOpen, setPlanOpen] = useState(true);

  // Timer turn-state: while a SERVER-side timer runs the composer is locked (the
  // turn is "busy waiting"). The Stop button opens a keep-or-cancel prompt;
  // cancelling stops the task so its scheduled resume is dropped.
  const [timerPrompt, setTimerPrompt] = useState<string | null>(null);

  // Outcomes of confirmed actions, fed to the model with the next message so it
  // knows what actually ran.
  const contextNotes = useRef<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Aborts the in-flight turn when the operator hits Stop.
  const abortRef = useRef<AbortController | null>(null);
  // Server-side agent tasks: the turn now runs on the SERVER, decoupled from any
  // open request, so it survives a reload/logout and re-runs timers on its own.
  // The client just attaches to (and reattaches to) the task's event stream.
  //  • lastSeqRef: highest frame seq seen per chat, so a reattach replays only
  //    what was missed (GET /api/assistant/stream?from=seq).
  //  • serverOwnedRef: chats with a live server task — excluded from the client's
  //    own chat-store push so it can't clobber the turn the server is writing.
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const serverOwnedRef = useRef<Set<string>>(new Set());
  // Guards the one-time task-reattach pass after load (so it runs exactly once).
  const activatedRef = useRef(false);
  // Mark/unmark a chat as having a live server task: update the ref (sync, for
  // push gating) AND the state (for the chat-list "working" cue).
  const markServerOwned = useCallback((id: string) => {
    serverOwnedRef.current.add(id);
    setLiveChats((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  const unmarkServerOwned = useCallback((id: string) => {
    serverOwnedRef.current.delete(id);
    setLiveChats((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev));
  }, []);

  // "Stuck to bottom" follows new content; once the operator scrolls up to read,
  // we stop yanking them back down until they return to the bottom themselves.
  const stickRef = useRef(true);
  const scrollToBottom = useCallback((smooth = false) => {
    stickRef.current = true;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    });
  }, []);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  }, []);

  // Load a chat's server-side workspace (notes + plan). Defined up here so the
  // mount/load effect can reference it without a temporal-dead-zone in its deps.
  const loadWorkspace = useCallback((id: string | null) => {
    if (!id) {
      setWorkspace(null);
      return;
    }
    void fetch(`/api/assistant/workspace?chatId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { workspace?: ChatWorkspaceDto } | null) => setWorkspace(d?.workspace ?? null))
      .catch(() => setWorkspace(null));
  }, []);

  // Operator clears this chat's plan and/or notes.
  const clearWs = useCallback((what: 'notes' | 'plan' | 'all') => {
    const id = activeIdRef.current;
    if (!id) return;
    void fetch('/api/assistant/workspace', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: id, what }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { workspace?: ChatWorkspaceDto } | null) => {
        if (d?.workspace) setWorkspace(d.workspace);
      })
      .catch(() => {
        /* leave the UI as-is on failure */
      });
  }, []);

  // ── Persistence ─────────────────────────────────────────────────────────
  //
  // The server (data/assistant-chats.json, via /api/assistant/chats) is the
  // cross-device source of truth so the same chats show up in every browser.
  // localStorage stays as a same-browser cache: written instantly so the UI is
  // never empty on reload and a momentary offline doesn't lose the transcript;
  // the server push is debounced (streaming mutates items rapidly).
  const pushTimerRef = useRef<number | null>(null);

  const pushServer = useCallback(() => {
    if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
    pushTimerRef.current = window.setTimeout(() => {
      // A chat with a LIVE server task is owned by the task runner (it's writing
      // that turn as it goes); omit it so a debounced client push can't overwrite
      // the in-progress turn with a stale snapshot. The server also guards this.
      const owned = serverOwnedRef.current;
      const chats =
        owned.size > 0 ? chatsRef.current.filter((c) => !owned.has(c.id)) : chatsRef.current;
      void fetch('/api/assistant/chats', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeId: activeIdRef.current, chats }),
      })
        .then((r) => {
          if (r.status === 401) setSessionExpired(true);
          else if (r.ok) setSessionExpired(false);
        })
        .catch(() => {
          /* offline — localStorage still holds it; the next write retries */
        });
    }, 800);
  }, []);

  const writeChats = useCallback(() => {
    try {
      window.localStorage.setItem(
        CHATS_KEY,
        JSON.stringify({ activeId: activeIdRef.current, chats: chatsRef.current }),
      );
    } catch {
      /* storage full or blocked — chat just won't persist locally */
    }
    pushServer();
  }, [pushServer]);

  /** Fold the live transcript into the active chat (creating it on first use). */
  const flush = useCallback(
    (liveItems: Item[]) => {
      if (liveItems.length === 0) {
        writeChats();
        return;
      }
      const now = Date.now();
      let chat = chatsRef.current.find((c) => c.id === activeIdRef.current);
      if (!chat) {
        // Reuse an id `send` may have minted up front (so the server-side
        // workspace it already keyed matches this persisted chat).
        chat = { id: activeIdRef.current ?? newId(), title: '', createdAt: now, updatedAt: now, items: [] };
        chatsRef.current.push(chat);
        activeIdRef.current = chat.id;
      }
      chat.items = liveItems.slice(-MAX_ITEMS);
      chat.updatedAt = now;
      const firstUser = liveItems.find((i) => i.kind === 'user');
      chat.title = (firstUser?.kind === 'user' ? firstUser.text : 'New chat').slice(0, 60);
      if (chatsRef.current.length > MAX_CHATS) {
        chatsRef.current = chatsRef.current
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, MAX_CHATS);
      }
      writeChats();
    },
    [writeChats],
  );

  // Load everything once: show the localStorage cache instantly, then reconcile
  // against the server's shared copy (and migrate any cache-only chats up).
  useEffect(() => {
    let localChats: StoredChat[] = [];
    let localActive: string | null = null;
    try {
      const raw = window.localStorage.getItem(CHATS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { activeId?: string; chats?: StoredChat[] };
        localChats = (parsed.chats ?? [])
          .filter((c) => c && typeof c.id === 'string')
          .map((c) => ({ ...c, items: sanitizeItems(c.items) }));
        localActive = parsed.activeId ?? null;
        chatsRef.current = localChats;
        const active = localChats.find((c) => c.id === localActive);
        if (active) {
          activeIdRef.current = active.id;
          setItems(active.items);
          loadWorkspace(active.id);
        }
      }
    } catch {
      /* corrupt cache — start clean */
    }

    // Reconcile with the server (cross-device truth). Keep the cache on
    // 401/offline so the panel isn't wiped; flag an expired session on 401.
    void fetch('/api/assistant/chats', { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401) {
          setSessionExpired(true);
          return null;
        }
        if (!r.ok) return null;
        return (await r.json()) as { activeId: string | null; chats?: StoredChat[] };
      })
      .then((server) => {
        if (!server) return; // offline / unauth — the local cache stands
        setSessionExpired(false); // a good response means the session is fine
        const serverChats = (server.chats ?? []).map((c) => ({
          ...c,
          items: sanitizeItems(c.items),
        }));
        const serverIds = new Set(serverChats.map((c) => c.id));
        chatsRef.current = mergeChats(serverChats, localChats);
        // Only swap the visible transcript if the operator hasn't already got a
        // chat open — never clobber something they're mid-way through.
        if (!activeIdRef.current) {
          const activeId = server.activeId ?? chatsRef.current[0]?.id ?? null;
          const active = chatsRef.current.find((c) => c.id === activeId);
          if (active) {
            activeIdRef.current = active.id;
            setItems(active.items);
            loadWorkspace(active.id);
          }
        }
        setChatList([...chatsRef.current].sort((a, b) => b.updatedAt - a.updatedAt));
        // Push the union up if the cache held chats the server didn't (the
        // one-time migration from the old localStorage-only build).
        if (localChats.some((c) => !serverIds.has(c.id))) writeChats();
      })
      .catch(() => {
        /* offline — the local cache is what we show */
      });

    try {
      const rawPick = window.localStorage.getItem(PICK_KEY);
      if (rawPick) setPick(JSON.parse(rawPick) as { provider: AssistantProvider; model: string });
      const rawMru = window.localStorage.getItem(MRU_KEY);
      if (rawMru) setMru(JSON.parse(rawMru) as Partial<Record<AssistantProvider, string[]>>);
      const savedMode = window.localStorage.getItem(MODE_KEY);
      if (savedMode === 'ask' || savedMode === 'agent') setMode(savedMode);
      else if (window.localStorage.getItem(LEGACY_ACTIONS_KEY) === '0') setMode('ask');
      const savedApproval = window.localStorage.getItem(APPROVAL_KEY);
      if (savedApproval === 'all' || savedApproval === 'critical' || savedApproval === 'auto') {
        setApproval(savedApproval);
      }
    } catch {
      /* keep defaults */
    }
    loadedRef.current = true;
    setChatsLoaded(true);
    scrollToBottom();
    // writeChats only runs on the one-time migration branch; it's stable.
  }, [scrollToBottom, writeChats, loadWorkspace]);

  // Persist the live transcript (debounced — streaming mutates items rapidly).
  useEffect(() => {
    if (!loadedRef.current || items.length === 0) return;
    const t = window.setTimeout(() => flush(items), 400);
    return () => window.clearTimeout(t);
  }, [items, flush]);

  // ── Model catalog ───────────────────────────────────────────────────────

  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/models', { cache: 'no-store' });
      if (res.ok) setCatalog((await res.json()) as ModelsResponse);
    } catch {
      /* menu falls back to the server default */
    }
  }, []);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  // Re-fetch when the menu opens so freshly-estimated multipliers (the GET also
  // kicks the background refresh) show up without a full page reload.
  useEffect(() => {
    if (menuOpen) void loadCatalog();
  }, [menuOpen, loadCatalog]);

  const effective = useMemo((): { provider: AssistantProvider; model: string } | null => {
    if (!catalog) return providerHint ? { provider: providerHint, model: '' } : null;
    const usable = (p: AssistantProvider) =>
      catalog.providers.find((x) => x.id === p)?.source != null;
    if (
      pick &&
      usable(pick.provider) &&
      (catalog.models[pick.provider] ?? []).some((m) => m.id === pick.model)
    ) {
      return pick;
    }
    if (catalog.defaults.provider) {
      return { provider: catalog.defaults.provider, model: catalog.defaults.model ?? '' };
    }
    return null;
  }, [catalog, pick, providerHint]);

  const modelLabel = useMemo(() => {
    if (!effective) return 'no model';
    const found = (catalog?.models[effective.provider] ?? []).find((m) => m.id === effective.model);
    return found?.label ?? (effective.model || effective.provider);
  }, [catalog, effective]);

  // Rough context-usage estimate for the wheel: ~4 chars/token over the
  // transcript + a fixed prompt/tools overhead, against the model's window.
  const ctx = useMemo(() => {
    const chars = items.reduce(
      (n, it) => n + ('text' in it ? it.text.length : 'label' in it ? it.label.length : 0),
      0,
    );
    const used = Math.ceil(chars / 4) + 1800;
    const window = effective ? contextWindowFor(effective.provider, effective.model) : 128_000;
    const pct = Math.min(100, Math.round((used / window) * 100));
    return { used, window, pct, level: pct >= 85 ? 'down' : pct >= 60 ? 'warn' : 'ok' };
  }, [items, effective]);

  // The id of the timer currently counting down (locks the composer), if any.
  const runningTimerId = useMemo(() => {
    const t = items.find((it) => it.kind === 'timer' && it.status === 'running');
    return t && t.kind === 'timer' ? t.id : null;
  }, [items]);
  // When the timer is gone (fired or cancelled) drop the prompt.
  useEffect(() => {
    if (!runningTimerId) setTimerPrompt(null);
  }, [runningTimerId]);
  const timerLocks = !!runningTimerId; // composer locked while a timer waits; button = Stop

  const choose = (provider: AssistantProvider, model: string) => {
    const next = { provider, model };
    setPick(next);
    // Bump this model to the front of the provider's recently-used list.
    setMru((prev) => {
      const list = [model, ...(prev[provider] ?? []).filter((m) => m !== model)].slice(0, MRU_MAX);
      const updated = { ...prev, [provider]: list };
      try {
        window.localStorage.setItem(MRU_KEY, JSON.stringify(updated));
      } catch {
        /* fine */
      }
      return updated;
    });
    try {
      window.localStorage.setItem(PICK_KEY, JSON.stringify(next));
    } catch {
      /* fine */
    }
  };

  const setModePersist = (m: AssistantMode) => {
    setMode(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      /* fine */
    }
  };

  const setApprovalPersist = (a: ApprovalLevel) => {
    setApproval(a);
    try {
      window.localStorage.setItem(APPROVAL_KEY, a);
    } catch {
      /* fine */
    }
  };

  const saveKey = async (provider: AssistantProvider) => {
    const key = (keyDraft[provider] ?? '').trim();
    if (!key) return;
    setKeyMsg(null);
    try {
      const res = await fetch('/api/assistant/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key, baseUrl: baseDraft[provider]?.trim() || undefined }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setKeyMsg(body.error ?? 'Could not save the key.');
        return;
      }
      setKeyDraft((d) => ({ ...d, [provider]: '' }));
      setKeyMsg('Key saved.');
      await loadCatalog();
    } catch {
      setKeyMsg('Could not save the key.');
    }
  };

  const revealKey = async (provider: AssistantProvider) => {
    if (shownKey[provider]) {
      setShownKey((s) => ({ ...s, [provider]: undefined }));
      return;
    }
    const value = await reveal('/api/assistant/keys/reveal', { provider });
    if (value) setShownKey((s) => ({ ...s, [provider]: value }));
  };

  const removeKey = async (provider: AssistantProvider) => {
    setKeyMsg(null);
    try {
      const res = await fetch('/api/assistant/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) setKeyMsg(body.error ?? 'Could not remove the key.');
      await loadCatalog();
    } catch {
      setKeyMsg('Could not remove the key.');
    }
  };

  // ── Chats ───────────────────────────────────────────────────────────────

  const newChat = () => {
    if (busy) return;
    flush(items);
    activeIdRef.current = null;
    setItems([]);
    setWorkspace(null);
    setView('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openChats = () => {
    flush(items);
    setChatList([...chatsRef.current].sort((a, b) => b.updatedAt - a.updatedAt));
    setView('chats');
  };

  const selectChat = (id: string) => {
    if (busy) return;
    flush(items);
    const chat = chatsRef.current.find((c) => c.id === id);
    if (!chat) return;
    activeIdRef.current = chat.id;
    setItems(chat.items);
    loadWorkspace(chat.id);
    setView('chat');
    scrollToBottom(); // open to the latest message, not the top
    // If this chat has a live server task (still running, or sleeping on a
    // timer), reattach to it / re-arm its countdown.
    void activateChatTasks();
  };

  const deleteChat = (id: string) => {
    chatsRef.current = chatsRef.current.filter((c) => c.id !== id);
    if (activeIdRef.current === id) {
      activeIdRef.current = null;
      setItems([]);
    }
    writeChats();
    setChatList([...chatsRef.current].sort((a, b) => b.updatedAt - a.updatedAt));
  };

  // ── Memory ──────────────────────────────────────────────────────────────

  const openMemory = () => {
    setView('memory');
    setNotes(null);
    void fetch('/api/assistant/memory', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { notes?: MemoryNoteDto[] } | null) => setNotes(d?.notes ?? []))
      .catch(() => setNotes([]));
  };

  const addNote = async () => {
    const text = noteDraft.trim();
    if (!text) return;
    try {
      const res = await fetch('/api/assistant/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = (await res.json()) as { note?: MemoryNoteDto; error?: string };
      if (res.ok && body.note) {
        setNotes((n) => [...(n ?? []), body.note!]);
        setNoteDraft('');
      }
    } catch {
      /* leave the draft so nothing is lost */
    }
  };

  const deleteNote = async (id: string) => {
    setNotes((n) => (n ?? []).filter((x) => x.id !== id));
    try {
      await fetch('/api/assistant/memory', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {
      /* worst case it reappears next open */
    }
  };

  // ── Chat transport ──────────────────────────────────────────────────────

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  // The panel has no layout while hidden (mobile drawer sits off-screen; the
  // desktop column collapses), so any scroll-to-bottom done then measures a
  // zero-height container and is lost — leaving the transcript pinned at the top
  // (oldest). When it becomes visible, or we return to the chat view, jump to the
  // newest message once layout has settled (double rAF).
  useEffect(() => {
    if (view !== 'chat') return;
    stickRef.current = true;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, view]);

  const stop = useCallback(() => {
    // Detach the local stream AND tell the server to stop the task (which cancels
    // any scheduled timer resume) — otherwise it would keep running server-side.
    abortRef.current?.abort();
    const chatId = activeIdRef.current;
    if (chatId) {
      unmarkServerOwned(chatId);
      void fetch('/api/assistant/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      }).catch(() => {
        /* the local stream is already detached */
      });
    }
  }, [unmarkServerOwned]);

  // /compact — replace the running transcript with a concise model-written brief
  // so the re-sent context (and its token cost) shrinks, while the model keeps
  // the task, discovered facts, and what ran. Reuses the normal endpoint in Ask
  // mode (no actions) so there's no separate per-provider summarizer.
  const compact = useCallback(async (targetPct?: number) => {
    if (busy || !effective || items.length === 0) return;
    setInput('');
    setBusy(true);
    // Target a share of the current transcript size. `/compact 10` → ~10%;
    // bare `/compact` → DEFAULT_COMPACT_PCT. Clamped to a sane band.
    const pct = Math.min(Math.max(targetPct ?? DEFAULT_COMPACT_PCT, 5), 90);
    const curChars = items.reduce(
      (n, it) => n + ('text' in it ? it.text.length : 'label' in it ? it.label.length : 0),
      0,
    );
    const targetChars = Math.max(200, Math.round((curChars * pct) / 100));
    setItems((prev) => [...prev, { kind: 'tool', label: `compacting context → ~${pct}%…` }]);
    const instruction =
      `Compact our conversation into a tight running brief I can continue from, targeting roughly ${pct}% of its current length (about ${targetChars} characters — be more aggressive the smaller that is). ` +
      'Cover: the goal/task, the key facts you discovered (vmids, nodes, entity ids, IPs, results), which actions ran and their outcomes, and what is still left to do. Short factual bullets. Output ONLY the brief — do not call any tools.';
    const controller = new AbortController();
    abortRef.current = controller;
    let summary = '';
    try {
      // Ephemeral one-shot (not a durable task): /compact just needs the brief.
      const res = await fetch('/api/assistant/oneshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: mergeConsecutive([...buildHistory(items), { role: 'user', content: instruction }]),
          mode: 'ask',
          approval,
          provider: effective.provider,
          model: effective.model || undefined,
        }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        setSessionExpired(true);
        setItems((prev) => prev.filter((it) => it.kind !== 'tool' || !it.label.startsWith('compacting context')));
        return;
      }
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line) as AssistantEvent;
              if (e.type === 'text') summary += e.text;
            } catch {
              /* partial line */
            }
          }
        }
      }
    } catch {
      /* fall through — if nothing came back we leave the chat untouched */
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
    // Drop the "compacting…" chip; if we got a brief, APPEND a compaction marker
    // (the full transcript stays on screen — only what's SENT to the model
    // shrinks, via buildHistory). Older /compact markers are superseded by this
    // newest one, so keep just the latest.
    setItems((prev) => {
      const cleaned = prev.filter(
        (it) =>
          !(it.kind === 'tool' && it.label.startsWith('compacting context')) &&
          it.kind !== 'compaction',
      );
      return summary.trim() ? [...cleaned, { kind: 'compaction', summary: summary.trim() }] : cleaned;
    });
    if (summary.trim()) scrollToBottom();
  }, [busy, effective, items, approval, scrollToBottom]);

  // ── Skills: slash commands handled client-side. A tiny registry so adding a
  // new one is a single entry; `arg` is everything typed after the name. ──
  const SKILLS = useMemo(
    () => [
      {
        name: 'compact',
        usage: '/compact [%]',
        summary: 'Summarize the chat to shrink context. Optional target: /compact 10 → ~10%.',
        run: (arg: string) => {
          const n = parseInt(arg, 10);
          void compact(Number.isFinite(n) ? n : undefined);
        },
      },
    ],
    [compact],
  );

  // ── Server-side task transport ────────────────────────────────────────────
  // A turn runs as a SERVER task; the client attaches to its NDJSON frame stream
  // and can detach/reattach freely. applyEvent folds one event into the
  // transcript (lifted out of send so reattach reuses it).
  const applyEvent = useCallback((e: AssistantEvent) => {
    if (e.type === 'workspace') {
      setWorkspace(e.workspace);
      return;
    }
    if (e.type === 'done' || e.type === 'sleep') return; // lifecycle, no transcript row
    setItems((prev) => {
      const next = [...prev];
      if (e.type === 'text') {
        const last = next[next.length - 1];
        if (last?.kind === 'assistant') next[next.length - 1] = { kind: 'assistant', text: last.text + e.text };
        else next.push({ kind: 'assistant', text: e.text });
      } else if (e.type === 'reasoning') {
        const last = next[next.length - 1];
        if (last?.kind === 'reasoning') next[next.length - 1] = { kind: 'reasoning', text: last.text + e.text };
        else next.push({ kind: 'reasoning', text: e.text });
      } else if (e.type === 'tool') {
        next.push({ kind: 'tool', label: e.label });
      } else if (e.type === 'proposal') {
        next.push({ kind: 'proposal', card: e.proposal, state: 'pending' });
      } else if (e.type === 'confirm') {
        next.push({ kind: 'action', id: e.card.id, title: e.card.title, status: 'pending', critical: e.critical, request: e.card.detail });
      } else if (e.type === 'reauth') {
        next.push({ kind: 'action', id: e.card.id, title: e.card.title, status: 'pending', reauth: true, request: e.card.detail });
      } else if (e.type === 'action') {
        const idx = next.findIndex((it) => it.kind === 'action' && it.id === e.id);
        const prior = idx >= 0 ? (next[idx] as Extract<Item, { kind: 'action' }>) : undefined;
        const row: Item = {
          kind: 'action',
          id: e.id,
          title: e.title,
          status: e.status,
          detail: e.detail,
          request: e.request ?? prior?.request,
          critical: prior?.critical,
        };
        if (idx >= 0) next[idx] = row;
        else next.push(row);
      } else if (e.type === 'timer') {
        // `until` is the server's authoritative wake time; fall back to now+secs.
        next.push({
          kind: 'timer',
          id: e.id,
          label: e.label,
          endsAt: e.until ?? Date.now() + e.seconds * 1000,
          status: 'running',
        });
      } else if (e.type === 'error') {
        next.push({ kind: 'error', text: e.message });
      }
      return next;
    });
  }, []);

  type PumpResult =
    | { reason: 'done' }
    | { reason: 'error' }
    | { reason: 'sleep'; until: number }
    | { reason: 'closed' };

  // Read frames off a task stream, applying each event and tracking the last seq
  // (so a reattach replays only what was missed). Returns why it stopped.
  const pumpStream = useCallback(
    async (chatId: string, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<PumpResult> => {
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return { reason: 'closed' };
          throw err;
        }
        if (chunk.done) return { reason: 'closed' };
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let frame: StreamFrame;
          try {
            frame = JSON.parse(line) as StreamFrame;
          } catch {
            continue;
          }
          if (typeof frame?.seq === 'number') lastSeqRef.current.set(chatId, frame.seq);
          const ev = frame?.event;
          if (!ev) continue;
          if (ev.type === 'sleep') {
            // The server owns the wait now — drop the connection and reattach at
            // wake (the countdown widget triggers it) instead of holding it open.
            try {
              await reader.cancel();
            } catch {
              /* already closed */
            }
            return { reason: 'sleep', until: ev.until };
          }
          applyEvent(ev);
          if (ev.type === 'done') return { reason: 'done' };
          if (ev.type === 'error') return { reason: 'error' };
        }
      }
    },
    [applyEvent],
  );

  // Open a reattach stream for a chat's live task from the last seq we saw.
  const openReattach = useCallback(
    async (chatId: string, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array> | null> => {
      const from = lastSeqRef.current.get(chatId) ?? 0;
      try {
        const res = await fetch(
          `/api/assistant/stream?chatId=${encodeURIComponent(chatId)}&from=${from}`,
          { cache: 'no-store', signal },
        );
        if (res.status === 401) {
          setSessionExpired(true);
          return null;
        }
        if (!res.ok || !res.body) return null; // 404 = no live task to attach to
        return res.body.getReader();
      } catch {
        return null;
      }
    },
    [],
  );

  // Pull a chat's transcript from the shared store (the server wrote the turn
  // there) — used after a detached or interrupted turn so the result shows up.
  const reloadChatFromServer = useCallback(async (chatId: string) => {
    try {
      const res = await fetch('/api/assistant/chats', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { chats?: StoredChat[] };
      const fresh = (data.chats ?? []).map((c) => ({ ...c, items: sanitizeItems(c.items) }));
      chatsRef.current = mergeChats(fresh, chatsRef.current);
      const chat = chatsRef.current.find((c) => c.id === chatId);
      if (chat && activeIdRef.current === chatId) setItems(chat.items);
      setChatList([...chatsRef.current].sort((a, b) => b.updatedAt - a.updatedAt));
    } catch {
      /* keep what we have */
    }
  }, []);

  // The turn (for this chat) is over: release the lock + ownership. `reload`
  // pulls the server-written transcript (needed when we missed live events).
  const finishTurn = useCallback(
    (chatId: string, opts?: { reload?: boolean }) => {
      unmarkServerOwned(chatId);
      if (activeIdRef.current === chatId) {
        setBusy(false);
        abortRef.current = null;
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      if (opts?.reload) void reloadChatFromServer(chatId);
    },
    [reloadChatFromServer, unmarkServerOwned],
  );

  // Drive a chat's stream to completion: pump, and on an unexpected close or a
  // server-side sleep, decide whether to reattach now, wait for the countdown,
  // or finish (pulling the stored result).
  const streamLoop = useCallback(
    async (chatId: string, firstReader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) => {
      let reader = firstReader;
      for (;;) {
        const result = await pumpStream(chatId, reader);
        if (result.reason === 'done' || result.reason === 'error') {
          finishTurn(chatId);
          return;
        }
        if (result.reason === 'sleep') {
          // Waiting on the server's timer — release the busy spinner; the timer
          // widget (or a reload) reattaches at wake. Chat stays server-owned.
          if (activeIdRef.current === chatId) setBusy(false);
          return;
        }
        // Closed unexpectedly (network blip / tunnel) — the task may live on.
        let status: TaskStatusDto | null = null;
        try {
          const r = await fetch('/api/assistant/tasks', { cache: 'no-store' });
          if (r.ok) {
            const d = (await r.json()) as { tasks?: TaskStatusDto[] };
            status = (d.tasks ?? []).find((t) => t.chatId === chatId) ?? null;
          }
        } catch {
          /* offline */
        }
        if (!status || status.status === 'done' || status.status === 'error') {
          finishTurn(chatId, { reload: true });
          return;
        }
        if (status.status === 'sleeping') {
          if (activeIdRef.current === chatId) setBusy(false);
          return; // countdown / reload reattaches at wake
        }
        // Still running server-side: reattach (small backoff to avoid a hot loop).
        await new Promise((r) => setTimeout(r, 500));
        const next = await openReattach(chatId, signal);
        if (!next) {
          finishTurn(chatId, { reload: true });
          return;
        }
        reader = next;
      }
    },
    [pumpStream, openReattach, finishTurn],
  );

  // Reattach to a chat's already-running task (after a timer wake, a reload, or
  // a dropped connection) and drive it to completion.
  const reattachResume = useCallback(
    async (chatId: string) => {
      markServerOwned(chatId);
      const controller = new AbortController();
      abortRef.current = controller;
      const reader = await openReattach(chatId, controller.signal);
      if (!reader) {
        // No live task — it finished while we were away; show the stored result.
        finishTurn(chatId, { reload: true });
        return;
      }
      if (activeIdRef.current === chatId) {
        setSessionExpired(false);
        setBusy(true);
      }
      await streamLoop(chatId, reader, controller.signal);
    },
    [openReattach, streamLoop, finishTurn, markServerOwned],
  );

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy || !effective) return;
      if (text.startsWith('/')) {
        const sp = text.indexOf(' ');
        const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
        const skill = SKILLS.find((s) => s.name === name);
        if (skill) {
          skill.run(sp === -1 ? '' : text.slice(sp + 1).trim());
          return;
        }
        // unknown /command → fall through and send it as a normal message
      }
      setInput('');
      setBusy(true);
      setMenuOpen(false);
      // Mint the chat id now so the server can key this chat's task + workspace
      // from the first message; flush() reuses the same id when it persists.
      if (!activeIdRef.current) activeIdRef.current = newId();
      const chatId = activeIdRef.current;
      markServerOwned(chatId);

      const notes = contextNotes.current.splice(0);
      const sent = notes.length > 0 ? `[context: ${notes.join('; ')}]\n${text}` : text;

      // Transcript for the API, with tool/action outcomes packed back in so the
      // model keeps its execution memory across turns (see buildHistory). Built
      // OUTSIDE the state updater (updaters can run twice in StrictMode).
      const history: ChatTurn[] = buildHistory(items);
      setItems((prev) => [...prev, { kind: 'user', text }]);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch('/api/assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: mergeConsecutive([...history, { role: 'user', content: sent }]),
            mode,
            approval,
            provider: effective.provider,
            model: effective.model || undefined,
            chatId,
          }),
          signal: controller.signal,
        });
        if (res.status === 401) {
          setSessionExpired(true);
          setItems((prev) => [
            ...prev,
            { kind: 'error', text: 'Your session expired — sign in again to continue.' },
          ]);
          finishTurn(chatId);
          return;
        }
        // A task is already running for this chat, or it finished before we could
        // attach — reattach (or pull the stored result) instead of erroring.
        if (res.status === 409 || res.status === 202) {
          await reattachResume(chatId);
          return;
        }
        if (!res.ok || !res.body) {
          let message = `Request failed (HTTP ${res.status}).`;
          try {
            const err = (await res.json()) as { error?: string };
            if (err.error) message = err.error;
          } catch {
            /* non-JSON */
          }
          setItems((prev) => [...prev, { kind: 'error', text: message }]);
          finishTurn(chatId);
          return;
        }
        setSessionExpired(false); // got a live stream — the session is valid
        await streamLoop(chatId, res.body.getReader(), controller.signal);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          // Stop pressed: the server task is told to stop in stop(); settle here.
          finishTurn(chatId, { reload: true });
        } else {
          // Connection dropped mid-turn — the task lives on server-side; reattach
          // rather than stranding the turn as "connection lost".
          void reattachResume(chatId);
        }
      }
    },
    [busy, effective, mode, approval, items, SKILLS, streamLoop, reattachResume, finishTurn, markServerOwned],
  );

  // Discover live server tasks on load / chat-switch and reattach the active one
  // (or re-arm its countdown if it's sleeping) so a reload never strands a turn.
  const activateChatTasks = useCallback(async () => {
    try {
      const r = await fetch('/api/assistant/tasks', { cache: 'no-store' });
      if (!r.ok) return;
      const d = (await r.json()) as { tasks?: TaskStatusDto[] };
      const live = d.tasks ?? [];
      for (const t of live) markServerOwned(t.chatId);
      const active = activeIdRef.current;
      const cur = active ? live.find((t) => t.chatId === active) : undefined;
      if (!cur || !active) return;
      if (cur.status === 'running') {
        void reattachResume(active);
      } else if (cur.status === 'sleeping' && cur.wakeAt) {
        // Re-arm the latest timer so the countdown shows and reattaches at wake.
        lastSeqRef.current.set(active, cur.seq);
        const wake = cur.wakeAt;
        setItems((prev) => {
          let lastTimer = -1;
          prev.forEach((it, i) => {
            if (it.kind === 'timer') lastTimer = i;
          });
          if (lastTimer < 0) return prev;
          return prev.map((it, i) =>
            i === lastTimer && it.kind === 'timer' ? { ...it, status: 'running', endsAt: wake } : it,
          );
        });
      }
    } catch {
      /* offline — the stored transcript stands */
    }
  }, [reattachResume, markServerOwned]);

  // Once chats are loaded, reattach the active chat's live task exactly once (a
  // reload landing back on a running/sleeping turn picks it up automatically).
  useEffect(() => {
    if (!chatsLoaded || activatedRef.current) return;
    activatedRef.current = true;
    void activateChatTasks();
  }, [chatsLoaded, activateChatTasks]);

  // Operator chose to keep the timer waiting — just dismiss the prompt.
  const keepTimer = useCallback(() => setTimerPrompt(null), []);

  // Operator cancelled the wait: stop the whole task (which cancels the server's
  // scheduled resume) and settle the countdown so the composer unlocks.
  const cancelTimerTask = useCallback((id: string) => {
    const chatId = activeIdRef.current;
    setItems((prev) =>
      prev.map((it) => (it.kind === 'timer' && it.id === id ? { ...it, status: 'stopped' } : it)),
    );
    if (chatId) {
      unmarkServerOwned(chatId);
      void fetch('/api/assistant/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      }).catch(() => {
        /* the timer is settled locally regardless */
      });
    }
    setBusy(false);
  }, [unmarkServerOwned]);

  // A countdown reached zero: mark it done and reattach — the SERVER resumes the
  // agent on its own (even if we were offline); this catches the resume live.
  const onTimerDone = useCallback(
    (id: string) => {
      setItems((prev) =>
        prev.map((it) => (it.kind === 'timer' && it.id === id ? { ...it, status: 'done' } : it)),
      );
      const chatId = activeIdRef.current;
      if (chatId) void reattachResume(chatId);
    },
    [reattachResume],
  );

  // Resolve an inline (agent-mode) action awaiting Run/Skip.
  const decide = useCallback(async (id: string, decision: 'run' | 'skip') => {
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'action' && it.id === id
          ? { ...it, status: decision === 'run' ? 'running' : 'skipped' }
          : it,
      ),
    );
    try {
      await fetch('/api/assistant/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
    } catch {
      /* the stream will reflect the real outcome regardless */
    }
  }, []);

  // Authorize a destructive (blacklisted) action with a fresh password + TOTP.
  // On success the server opens the 30-min elevation window and resumes the turn;
  // on a bad credential the action stays paused so the form can be retried.
  const reauthDecide = useCallback(
    async (id: string, password: string, code: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch('/api/assistant/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, decision: 'run', password, code }),
        });
        if (res.ok) {
          setItems((prev) =>
            prev.map((it) => (it.kind === 'action' && it.id === id ? { ...it, status: 'running' } : it)),
          );
          return { ok: true };
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: body.error ?? 'Could not authorize.' };
      } catch {
        return { ok: false, error: 'Network error — try again.' };
      }
    },
    [],
  );

  const confirm = async (card: ProposalCard) => {
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'proposal' && it.card.id === card.id ? { ...it, state: 'running' } : it,
      ),
    );
    let state: ProposalState = 'fail';
    let result = 'Execution failed.';
    try {
      const res = await fetch('/api/assistant/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: card.id }),
      });
      const body = (await res.json()) as { ok?: boolean; detail?: string };
      if (res.status === 410) {
        state = 'gone';
        result = body.detail ?? 'Proposal expired.';
      } else {
        state = body.ok ? 'ok' : 'fail';
        result = body.detail ?? (body.ok ? 'Done.' : 'Failed.');
      }
    } catch {
      /* keep the failure defaults */
    }
    contextNotes.current.push(
      `operator ${state === 'ok' ? 'confirmed and executed' : 'tried'} "${card.title}" — ${result}`,
    );
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'proposal' && it.card.id === card.id ? { ...it, state, result } : it,
      ),
    );
  };

  const dismiss = (card: ProposalCard) => {
    contextNotes.current.push(`operator dismissed the proposal "${card.title}" — it did NOT run`);
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'proposal' && it.card.id === card.id
          ? { ...it, state: 'gone', result: 'Dismissed.' }
          : it,
      ),
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────

  const configuredProviders = catalog?.providers.filter((p) => p.source != null) ?? [];

  return (
    <aside className={styles.sidebar} data-open={open || undefined} aria-label="Operator assistant">
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <Bot size={16} strokeWidth={2.2} aria-hidden />
          Operator
          {effective ? (
            <span className={`${styles.providerTag} mono`}>{effective.provider}</span>
          ) : null}
        </span>
        <div className={styles.headControls}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={newChat}
            disabled={busy}
            aria-label="New chat"
            title="New chat"
          >
            <SquarePen size={15} strokeWidth={2.2} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            data-active={view === 'chats' || undefined}
            onClick={() => (view === 'chats' ? setView('chat') : openChats())}
            aria-label="Chat history"
            title="Chat history"
          >
            <History size={15} strokeWidth={2.2} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            data-active={view === 'memory' || undefined}
            onClick={() => (view === 'memory' ? setView('chat') : openMemory())}
            aria-label="Assistant memory"
            title="Assistant memory"
          >
            <Brain size={15} strokeWidth={2.2} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label="Hide assistant"
          >
            <ChevronRight size={16} strokeWidth={2.2} aria-hidden className={styles.closeDesktop} />
            <X size={16} strokeWidth={2.2} aria-hidden className={styles.closeMobile} />
          </button>
        </div>
      </header>

      {view === 'chats' ? (
        <div className={styles.scroll}>
          <div className={styles.viewHead}>
            <button type="button" className={styles.backBtn} onClick={() => setView('chat')}>
              <ArrowLeft size={14} strokeWidth={2.2} aria-hidden /> Back
            </button>
            <span className={styles.viewTitle}>Chats</span>
          </div>
          {chatList.length === 0 ? (
            <p className={styles.emptyNote}>No saved chats yet.</p>
          ) : (
            chatList.map((c) => (
              <div
                key={c.id}
                className={styles.chatRow}
                data-active={c.id === activeIdRef.current || undefined}
              >
                <button
                  type="button"
                  className={styles.chatPick}
                  onClick={() => selectChat(c.id)}
                  disabled={busy}
                >
                  <span className={styles.chatTitle}>{c.title || 'New chat'}</span>
                  {liveChats.includes(c.id) ? (
                    <span
                      className={styles.chatLive}
                      role="img"
                      aria-label="Agent working"
                      title="The agent is working on this chat"
                    />
                  ) : null}
                  <span className={`${styles.chatTime} mono`}>{timeAgo(c.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => deleteChat(c.id)}
                  aria-label={`Delete chat "${c.title || 'New chat'}"`}
                >
                  <Trash2 size={14} strokeWidth={2.2} aria-hidden />
                </button>
              </div>
            ))
          )}
        </div>
      ) : view === 'memory' ? (
        <div className={styles.scroll}>
          <div className={styles.viewHead}>
            <button type="button" className={styles.backBtn} onClick={() => setView('chat')}>
              <ArrowLeft size={14} strokeWidth={2.2} aria-hidden /> Back
            </button>
            <span className={styles.viewTitle}>Memory</span>
          </div>
          <p className={styles.memoryHint}>
            Durable notes the assistant saves about the lab (and reads in every chat). It adds them
            when you correct it; you can add or remove them here.
          </p>
          {notes == null ? (
            <p className={styles.emptyNote}>Loading…</p>
          ) : notes.length === 0 ? (
            <p className={styles.emptyNote}>Nothing remembered yet.</p>
          ) : (
            notes.map((n) => (
              <div key={n.id} className={styles.memoryRow}>
                <p className={styles.memoryText}>{n.text}</p>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => deleteNote(n.id)}
                  aria-label="Delete note"
                >
                  <Trash2 size={14} strokeWidth={2.2} aria-hidden />
                </button>
              </div>
            ))
          )}
          <form
            className={styles.memoryAdd}
            onSubmit={(e) => {
              e.preventDefault();
              void addNote();
            }}
          >
            <input
              type="text"
              className={styles.memoryInput}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Add a note the assistant should remember…"
              aria-label="New memory note"
            />
            <button type="submit" className={styles.iconBtn} aria-label="Save note">
              <Plus size={15} strokeWidth={2.2} aria-hidden />
            </button>
          </form>
        </div>
      ) : (
        <div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
          {sessionExpired ? (
            <div className={styles.sessionBanner} role="alert">
              <span>Session expired. Sign in again to keep using the assistant.</span>
              <a className={styles.sessionLink} href="/login">
                Sign in
              </a>
            </div>
          ) : null}
          {workspace && (workspace.plan.length > 0 || workspace.notes.length > 0) ? (
            <section className={styles.workspace} aria-label="This chat's plan and notes">
              <button
                type="button"
                className={styles.wsHead}
                onClick={() => setPlanOpen((o) => !o)}
                aria-expanded={planOpen}
              >
                <ListChecks size={14} strokeWidth={2.2} aria-hidden />
                <span className={styles.wsTitle}>This chat</span>
                {workspace.plan.length > 0 ? (
                  <span className={`${styles.wsCount} mono tnum`}>
                    {workspace.plan.filter((s) => s.status === 'done').length}/{workspace.plan.length}
                  </span>
                ) : null}
                <ChevronUp
                  size={13}
                  strokeWidth={2.2}
                  aria-hidden
                  data-flip={planOpen || undefined}
                  className={styles.wsChevron}
                />
              </button>
              {planOpen ? (
                <div className={styles.wsBody}>
                  {workspace.plan.length > 0 ? (
                    <ol className={styles.planList}>
                      {workspace.plan.map((s) => (
                        <li key={s.id} className={styles.planStep} data-status={s.status}>
                          <span className={styles.planMark} data-status={s.status} aria-hidden />
                          <span className={styles.planText}>{s.text}</span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {workspace.notes.length > 0 ? (
                    <div className={styles.wsNotes}>
                      <span className={styles.wsNotesLabel}>Notes</span>
                      {workspace.notes.map((n) => (
                        <p key={n.id} className={styles.wsNoteText}>
                          {n.text}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  <div className={styles.wsActions}>
                    {workspace.plan.length > 0 ? (
                      <button type="button" className={styles.wsClear} onClick={() => clearWs('plan')}>
                        Clear plan
                      </button>
                    ) : null}
                    {workspace.notes.length > 0 ? (
                      <button type="button" className={styles.wsClear} onClick={() => clearWs('notes')}>
                        Clear notes
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
          {!effective && catalog ? (
            <div className={styles.empty}>
              <p>No model key configured.</p>
              <p className={styles.emptySub}>
                Add an API key in the model menu below (stored server-side, never shown again), or
                set it in <code className="mono">.env.local</code>.
              </p>
              <button
                type="button"
                className={styles.suggestion}
                onClick={() => {
                  setMenuOpen(true);
                  setKeysOpen(true);
                }}
              >
                Add an API key
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className={styles.empty}>
              <p>Ask anything about the lab — the assistant reads the same live data as these panels.</p>
              <div className={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className={styles.suggestion} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            groupRows(items).map((it, i) => {
              switch (it.kind) {
                case 'user':
                  return (
                    <div key={i} className={styles.user}>
                      {it.text}
                    </div>
                  );
                case 'assistant':
                  return (
                    <div key={i} className={styles.assistant}>
                      <Markdown text={it.text} />
                    </div>
                  );
                case 'reasoning':
                  return <ReasoningBlock key={i} text={it.text} />;
                case 'toolgroup':
                  return <ToolGroupChip key={i} labels={it.labels} />;
                case 'error':
                  return (
                    <div key={i} className={styles.errorRow} role="alert">
                      {it.text}
                    </div>
                  );
                case 'action':
                  return <ActionCard key={it.id} item={it} onDecide={decide} onReauth={reauthDecide} />;
                case 'timer':
                  return (
                    <TimerWidget key={it.id} item={it} onStop={(id) => setTimerPrompt(id)} onDone={onTimerDone} />
                  );
                case 'compaction':
                  return (
                    <div key={i} className={styles.compactDivider} title={it.summary}>
                      <span className={styles.compactLine} aria-hidden />
                      <span className={styles.compactLabel}>
                        context compacted — older messages stay here but aren’t re-sent
                      </span>
                      <span className={styles.compactLine} aria-hidden />
                    </div>
                  );
                case 'proposal': {
                  const { card, state, result } = it;
                  return (
                    <div key={card.id} className={styles.proposal} data-state={state}>
                      <p className={`${styles.proposalTitle} mono`}>{card.title}</p>
                      <p className={styles.proposalDetail}>{card.detail}</p>
                      {state === 'pending' ? (
                        <div className={styles.proposalActions}>
                          <button
                            type="button"
                            className={styles.confirmBtn}
                            onClick={() => confirm(card)}
                          >
                            <Check size={14} strokeWidth={2.4} aria-hidden /> Run it
                          </button>
                          <button
                            type="button"
                            className={styles.dismissBtn}
                            onClick={() => dismiss(card)}
                          >
                            Dismiss
                          </button>
                        </div>
                      ) : (
                        <p className={styles.proposalResult} data-state={state}>
                          {state === 'running' ? 'Running…' : result}
                        </p>
                      )}
                    </div>
                  );
                }
              }
            })
          )}
          {busy ? (
            <div className={`${styles.thinking} mono`} aria-live="polite">
              <span className={styles.thinkingDot} />
              working
            </div>
          ) : null}
        </div>
      )}

      {view === 'chat' ? (
      <div className={styles.composerArea}>
        {menuOpen ? (
          <>
            <button
              type="button"
              className={styles.menuScrim}
              onClick={() => setMenuOpen(false)}
              aria-label="Close model menu"
            />
            <div className={styles.menuPop} role="menu" aria-label="Model">
              <div className={styles.menuSection}>
                {configuredProviders.length === 0 ? (
                  <p className={styles.menuHint}>No provider configured yet — add a key below.</p>
                ) : (
                  configuredProviders.map((p) => {
                    const all = catalog?.models[p.id] ?? [];
                    const isSel = (id: string) =>
                      effective?.provider === p.id && effective.model === id;
                    // The lead list is capped at MRU_MAX: recently-used models
                    // first, then the default featured picks fill any remaining
                    // slots. Use 3 other models and the defaults drop into "More".
                    const ids = new Set(all.map((m) => m.id));
                    const recent = (mru[p.id] ?? []).filter((id) => ids.has(id));
                    const featured = all.filter((m) => m.featured).map((m) => m.id);
                    const mainIds = new Set<string>();
                    for (const id of [...recent, ...featured]) {
                      if (mainIds.size >= MRU_MAX) break;
                      mainIds.add(id);
                    }
                    const inMain = (id: string) => mainIds.has(id) || isSel(id);
                    const lead = all.filter((m) => inMain(m.id));
                    const rest = all.filter((m) => !inMain(m.id));
                    const showRest = moreOpen[p.id] === true;
                    const row = (m: (typeof all)[number]) => (
                      <button
                        key={m.id}
                        type="button"
                        className={styles.modelRow}
                        data-on={isSel(m.id) || undefined}
                        onClick={() => {
                          choose(p.id, m.id);
                          setMenuOpen(false);
                        }}
                      >
                        <span className={styles.modelName}>{m.label}</span>
                        <span className={`${styles.multBadge} mono`}>
                          {m.multiplier != null ? `${m.multiplier}x` : '–x'}
                        </span>
                        {isSel(m.id) ? <Check size={14} strokeWidth={2.4} aria-hidden /> : null}
                      </button>
                    );
                    return (
                      <div key={p.id}>
                        <span className={`${styles.menuLabel} mono`}>{p.label}</span>
                        {lead.map(row)}
                        {rest.length > 0 ? (
                          <>
                            <button
                              type="button"
                              className={styles.moreToggle}
                              onClick={() =>
                                setMoreOpen((o) => ({ ...o, [p.id]: !showRest }))
                              }
                              aria-expanded={showRest}
                            >
                              {showRest ? 'Fewer models' : `More models (${rest.length})`}
                            </button>
                            {showRest ? rest.map(row) : null}
                          </>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>

              <div className={styles.menuSection}>
                <button
                  type="button"
                  className={styles.keysToggle}
                  onClick={() => setKeysOpen((v) => !v)}
                  aria-expanded={keysOpen}
                >
                  <KeyRound size={13} strokeWidth={2.2} aria-hidden /> API keys
                </button>
                {keysOpen ? (
                  <div className={styles.keysList}>
                    {(catalog?.providers ?? []).map((p) => (
                      <div key={p.id} className={styles.keyRow}>
                        <span className={styles.keyName}>
                          {p.label}
                          <span className={`${styles.keyStatus} mono`} data-set={p.source != null || undefined}>
                            {p.source ?? 'not set'}
                          </span>
                          {p.source ? (
                            <button
                              type="button"
                              className={styles.keyEye}
                              onClick={() => void revealKey(p.id)}
                              aria-label={shownKey[p.id] ? `Hide ${p.label} key` : `Reveal ${p.label} key`}
                              title={shownKey[p.id] ? 'Hide' : 'Reveal (re-auth)'}
                            >
                              <Eye size={13} strokeWidth={2.2} aria-hidden />
                            </button>
                          ) : null}
                        </span>
                        {shownKey[p.id] ? (
                          <code className={`${styles.keyReveal} mono`}>{shownKey[p.id]}</code>
                        ) : null}
                        <span className={styles.keyControls}>
                          <input
                            type="password"
                            className={styles.keyInput}
                            value={keyDraft[p.id] ?? ''}
                            onChange={(e) => setKeyDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                            placeholder={
                              p.source === 'env'
                                ? 'Override .env key…'
                                : p.source === 'stored'
                                  ? 'Replace key…'
                                  : 'Paste API key…'
                            }
                            autoComplete="off"
                            aria-label={`${p.label} API key`}
                          />
                          <button
                            type="button"
                            className={styles.keyBtn}
                            onClick={() => void saveKey(p.id)}
                            disabled={!(keyDraft[p.id] ?? '').trim()}
                          >
                            Save
                          </button>
                          {p.source === 'stored' ? (
                            <button
                              type="button"
                              className={styles.iconBtn}
                              onClick={() => void removeKey(p.id)}
                              aria-label={`Remove stored ${p.label} key`}
                              title="Remove stored key"
                            >
                              <Trash2 size={14} strokeWidth={2.2} aria-hidden />
                            </button>
                          ) : null}
                        </span>
                        {p.customBaseUrl ? (
                          <input
                            type="text"
                            className={`${styles.keyInput} ${styles.baseInput} mono`}
                            value={baseDraft[p.id] ?? ''}
                            onChange={(e) => setBaseDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                            placeholder={p.baseUrl ?? 'Custom base URL (optional)'}
                            autoComplete="off"
                            aria-label={`${p.label} base URL`}
                          />
                        ) : null}
                      </div>
                    ))}
                    {keyMsg ? <p className={styles.keyMsg}>{keyMsg}</p> : null}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        {modeMenuOpen ? (
          <>
            <button
              type="button"
              className={styles.menuScrim}
              onClick={() => setModeMenuOpen(false)}
              aria-label="Close mode menu"
            />
            <div className={`${styles.menuPop} ${styles.modePop}`} role="menu" aria-label="Mode">
              <div className={styles.menuSection}>
                <span className={`${styles.menuLabel} mono`}>mode</span>
                <div className={styles.segmented} role="radiogroup" aria-label="Assistant mode">
                  {(['ask', 'agent'] as AssistantMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      className={styles.segBtn}
                      data-on={mode === m || undefined}
                      onClick={() => setModePersist(m)}
                    >
                      {m === 'ask' ? 'Ask' : 'Agent'}
                    </button>
                  ))}
                </div>
                {mode === 'agent' ? (
                  <>
                    <span className={`${styles.menuLabel} mono`}>approval</span>
                    <div className={styles.segmented} role="radiogroup" aria-label="Approval level">
                      {APPROVALS.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          role="radio"
                          aria-checked={approval === a.id}
                          className={styles.segBtn}
                          data-on={approval === a.id || undefined}
                          onClick={() => setApprovalPersist(a.id)}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                    <p className={styles.menuHint}>{APPROVALS.find((a) => a.id === approval)?.hint}</p>
                  </>
                ) : (
                  <p className={styles.menuHint}>
                    Advises and proposes fixes — nothing runs until you confirm a card.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : null}

        <div className={styles.chipRow}>
          <button
            type="button"
            className={styles.modelChip}
            onClick={() => {
              setMenuOpen((v) => !v);
              setModeMenuOpen(false);
            }}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <span className={styles.modelChipName}>{modelLabel}</span>
            <ChevronUp size={13} strokeWidth={2.2} aria-hidden data-flip={menuOpen || undefined} />
          </button>
          <button
            type="button"
            className={styles.modeChip}
            onClick={() => {
              setModeMenuOpen((v) => !v);
              setMenuOpen(false);
            }}
            aria-expanded={modeMenuOpen}
            aria-haspopup="menu"
            title="Mode & approval"
          >
            <span className={styles.modeChipName}>{mode === 'ask' ? 'Ask' : 'Agent'}</span>
            {mode === 'agent' ? <span className={`${styles.modeTag} mono`}>{approval}</span> : null}
            <ChevronUp size={13} strokeWidth={2.2} aria-hidden data-flip={modeMenuOpen || undefined} />
          </button>
          {effective ? (
            <span
              className={styles.ctxPill}
              data-level={ctx.level}
              data-tip={`${ctx.pct}% of context · ~${ctx.used.toLocaleString()} / ${ctx.window.toLocaleString()} tokens · /compact to shrink`}
              aria-label={`Context ${ctx.pct} percent used`}
            >
              <svg className={styles.ctxRing} viewBox="0 0 20 20" width="13" height="13" aria-hidden>
                <circle cx="10" cy="10" r="7" fill="none" stroke="var(--border-strong)" strokeWidth="3.2" opacity="0.4" />
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeDasharray={`${((ctx.pct / 100) * 43.98).toFixed(2)} 43.98`}
                  transform="rotate(-90 10 10)"
                />
              </svg>
              <span className={`${styles.ctxPct} mono tnum`}>{ctx.pct}%</span>
            </span>
          ) : null}
        </div>

        {input.startsWith('/') && !busy
          ? (() => {
              const q = input.slice(1).split(' ')[0].toLowerCase();
              const matches = SKILLS.filter((s) => s.name.startsWith(q));
              return matches.length > 0 ? (
                <div className={styles.skillHint} role="listbox" aria-label="Skills">
                  {matches.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      className={styles.skillRow}
                      onClick={() => {
                        setInput('/' + s.name + ' ');
                        inputRef.current?.focus();
                      }}
                    >
                      <span className={`${styles.skillName} mono`}>{s.usage}</span>
                      <span className={styles.skillDesc}>{s.summary}</span>
                    </button>
                  ))}
                </div>
              ) : null;
            })()
          : null}

        {timerPrompt ? (
          <div className={styles.timerPrompt} role="dialog" aria-label="Timer running">
            <span className={styles.timerPromptText}>
              The agent is waiting on a timer. Keep waiting, or cancel and stop it?
            </span>
            <div className={styles.timerPromptBtns}>
              <button type="button" className={styles.timerKeep} onClick={keepTimer}>
                Keep waiting
              </button>
              <button
                type="button"
                className={styles.timerDelete}
                onClick={() => {
                  cancelTimerTask(timerPrompt);
                  setTimerPrompt(null);
                }}
              >
                Cancel timer
              </button>
            </div>
          </div>
        ) : null}

        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            ref={inputRef}
            className={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={
              !effective
                ? 'Add an API key first'
                : timerLocks
                  ? 'Timer running — press Stop to cancel'
                  : 'Ask the lab…'
            }
            rows={1}
            disabled={!effective || timerLocks}
            aria-label="Message the assistant"
          />
          {busy || timerLocks ? (
            <button
              type="button"
              className={`${styles.sendBtn} ${styles.stopBtn}`}
              onClick={() => {
                if (busy) stop();
                else if (runningTimerId) setTimerPrompt(runningTimerId);
              }}
              aria-label={busy ? 'Stop' : 'Interrupt timer'}
              title={busy ? 'Stop' : 'Interrupt the timer'}
            >
              <Square size={13} strokeWidth={2.6} aria-hidden fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              className={styles.sendBtn}
              disabled={!effective || input.trim() === ''}
              aria-label="Send"
            >
              <Send size={15} strokeWidth={2.2} aria-hidden />
            </button>
          )}
        </form>
      </div>
      ) : null}
    </aside>
  );
}

/** An inline agent action. Pending → Run/Skip. Otherwise a one-line status with
 *  the full call/result hidden behind an expander (the raw JSON is noise until
 *  you want it). */
function ActionCard({
  item,
  onDecide,
  onReauth,
}: {
  item: Extract<Item, { kind: 'action' }>;
  onDecide: (id: string, d: 'run' | 'skip') => void;
  onReauth: (id: string, password: string, code: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false);
  // Re-auth form state (only used when item.reauth && pending).
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const { id, title, status, critical, reauth, detail, request } = item;
  const statusWord =
    status === 'running' ? 'Running…' : status === 'ok' ? 'Done' : status === 'fail' ? 'Failed' : 'Skipped';
  // Expandable whenever we have something to show — what was SENT and/or the
  // result. The body splits the two so you can always see the command/request,
  // not just the output.
  const expandable = Boolean(request || detail);
  return (
    <div className={styles.action} data-status={status}>
      <div className={styles.actionHead}>
        <span className={styles.actionDot} aria-hidden />
        <span className={styles.actionTitle}>{title}</span>
        {critical && status === 'pending' ? (
          <span className={`${styles.actionRisk} mono`}>critical</span>
        ) : null}
        {reauth && status === 'pending' ? (
          <span className={`${styles.actionRisk} mono`} data-reauth>
            re-auth
          </span>
        ) : null}
        {expandable ? (
          <button
            type="button"
            className={styles.actionExpand}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'Hide details' : 'Show details'}
          >
            <ChevronDown size={13} strokeWidth={2.2} aria-hidden data-flip={open || undefined} />
          </button>
        ) : null}
      </div>
      {status !== 'pending' ? (
        <p className={styles.actionResult} data-status={status}>
          {statusWord}
        </p>
      ) : null}
      {open ? (
        <div className={styles.actionSections}>
          {request ? (
            <div className={styles.actionSection}>
              <span className={`${styles.actionSectionLabel} mono`}>sent</span>
              <pre className={styles.actionDetail}>{request}</pre>
            </div>
          ) : null}
          {detail ? (
            <div className={styles.actionSection}>
              <span className={`${styles.actionSectionLabel} mono`}>
                {status === 'fail' ? 'error' : 'output'}
              </span>
              <pre className={styles.actionDetail}>{detail}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
      {status === 'pending' ? (
        reauth ? (
          <form
            className={styles.reauthForm}
            onSubmit={async (e) => {
              e.preventDefault();
              setAuthBusy(true);
              setAuthErr(null);
              const r = await onReauth(id, pw, code);
              if (!r.ok) {
                setAuthErr(r.error ?? 'Re-authentication failed.');
                setAuthBusy(false);
              }
              // On success the item leaves 'pending' (→ running) and this unmounts.
            }}
          >
            <p className={styles.reauthNote}>
              Destructive action — re-authorize to run it. Opens a 30-minute window so further
              destructive steps don’t re-prompt.
            </p>
            <input
              type="password"
              className={styles.reauthInput}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Password"
              autoComplete="off"
              aria-label="Password"
            />
            <input
              type="text"
              inputMode="numeric"
              className={styles.reauthInput}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="2FA code"
              autoComplete="off"
              aria-label="Authentication code"
            />
            {authErr ? <p className={styles.reauthError}>{authErr}</p> : null}
            <div className={styles.proposalActions}>
              <button type="submit" className={styles.confirmBtn} disabled={authBusy || !pw}>
                <Check size={14} strokeWidth={2.4} aria-hidden /> {authBusy ? 'Authorizing…' : 'Authorize'}
              </button>
              <button type="button" className={styles.dismissBtn} onClick={() => onDecide(id, 'skip')}>
                Skip
              </button>
            </div>
          </form>
        ) : (
          <div className={styles.proposalActions}>
            <button type="button" className={styles.confirmBtn} onClick={() => onDecide(id, 'run')}>
              <Check size={14} strokeWidth={2.4} aria-hidden /> Run
            </button>
            <button type="button" className={styles.dismissBtn} onClick={() => onDecide(id, 'skip')}>
              Skip
            </button>
          </div>
        )
      ) : null}
    </div>
  );
}

/** A folded run of tool-lookup chips. One chip stays inline; a run collapses to
 *  "N steps" that expands to the individual lookups. */
function ToolGroupChip({ labels }: { labels: string[] }) {
  const [open, setOpen] = useState(false);
  if (labels.length === 1) {
    return <div className={`${styles.toolChip} mono`}>{labels[0]}</div>;
  }
  return (
    <div className={styles.toolGroup} data-open={open || undefined}>
      <button
        type="button"
        className={styles.toolGroupToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown size={12} strokeWidth={2.2} aria-hidden data-flip={open || undefined} />
        <span className="mono">{labels.length} steps</span>
      </button>
      {open ? (
        <div className={styles.toolGroupList}>
          {labels.map((l, i) => (
            <span key={i} className={`${styles.toolChip} mono`}>
              {l}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A live ETA countdown the model set before waiting. Ticks client-side; when it
 *  hits zero (and wasn't paused) it fires onDone ONCE, which re-invokes the
 *  assistant to continue. Stop cancels the auto-resume so you can interject. */
function TimerWidget({
  item,
  onStop,
  onDone,
}: {
  item: Extract<Item, { kind: 'timer' }>;
  onStop: (id: string) => void;
  onDone: (id: string, label: string) => void;
}) {
  const { id, label, endsAt, status } = item;
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
  const firedRef = useRef(false);

  useEffect(() => {
    if (status !== 'running') return;
    const tick = () => {
      const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setRemaining(rem);
      if (rem <= 0 && !firedRef.current) {
        firedRef.current = true;
        onDone(id, label);
      }
    };
    tick();
    const t = window.setInterval(tick, 250);
    return () => window.clearInterval(t);
  }, [status, endsAt, id, label, onDone]);

  const pad2 = (n: number) => n.toString().padStart(2, '0');
  const hh = Math.floor(remaining / 3600);
  const mm = Math.floor((remaining % 3600) / 60);
  const ss = remaining % 60;
  const clock = hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
  const stateWord =
    status === 'running' ? clock : status === 'done' ? 'continued' : 'paused';

  return (
    <div className={styles.timer} data-status={status}>
      <Clock size={14} strokeWidth={2.2} aria-hidden className={styles.timerIcon} />
      <span className={styles.timerLabel}>{label}</span>
      <span className={`${styles.timerClock} mono`}>{stateWord}</span>
      {status === 'running' ? (
        <button type="button" className={styles.timerStop} onClick={() => onStop(id)}>
          Stop
        </button>
      ) : null}
    </div>
  );
}

/** Collapsible reasoning ("thinking") block — captured from the model's real
 *  reasoning channel, separate from the answer. Collapsed by default. Empty
 *  reasoning (a provider emits a blank thought) renders nothing. */
function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className={styles.reasoning} data-open={open || undefined}>
      <button type="button" className={styles.reasoningToggle} onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={13} strokeWidth={2.2} aria-hidden data-flip={open || undefined} />
        <span className={`${styles.reasoningLabel} mono`}>thinking</span>
      </button>
      {open ? <div className={styles.reasoningBody}>{text}</div> : null}
    </div>
  );
}
