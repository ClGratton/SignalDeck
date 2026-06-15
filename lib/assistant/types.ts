// Client-safe types shared between the assistant API routes and the sidebar UI.
// No server imports here — the chat components import these directly.

export type AssistantProvider = 'anthropic' | 'gemini' | 'openai' | 'deepseek' | 'glm';

/** Ask = advise + propose (out-of-band cards). Agent = execute tasks inline. */
export type AssistantMode = 'ask' | 'agent';

/** In Agent mode: how much the operator must approve.
 *  - all: confirm every action.
 *  - critical: auto-run safe actions, confirm only destructive ones.
 *  - auto: fully autonomous, never pause. */
export type ApprovalLevel = 'all' | 'critical' | 'auto';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A proposed action awaiting the operator's explicit confirmation. The server
 *  holds the executable side; the client only ever sees this card. */
export interface ProposalCard {
  id: string;
  /** Short imperative summary, e.g. `stop lxc 104 (jellyfin) on pve`. */
  title: string;
  /** One-line explanation of what will happen when confirmed. */
  detail: string;
  /** Epoch ms after which the proposal can no longer be confirmed. */
  expiresAt: number;
}

/** Status of an inline (agent-mode) action as it progresses. */
export type ActionStatus = 'pending' | 'running' | 'ok' | 'fail' | 'skipped';

/** NDJSON events streamed by POST /api/assistant. */
export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; name: string; label: string }
  /** Ask mode: an out-of-band proposal card (confirmed later via /execute). */
  | { type: 'proposal'; proposal: ProposalCard }
  /** Agent mode: an action awaiting an inline Run/Skip decision (/decide). */
  | { type: 'confirm'; card: ProposalCard; critical: boolean }
  /** A destructive (blacklisted) action that needs a FRESH re-auth before it
   *  runs; the client posts password + TOTP to /decide. Granted re-auth opens a
   *  ~30-min window so further destructive actions skip the prompt. */
  | { type: 'reauth'; card: ProposalCard }
  /** Agent mode: progress of an inline action (auto-run or post-confirm). */
  | { type: 'action'; id: string; title: string; status: ActionStatus; detail?: string; request?: string }
  /** A countdown the model set before waiting. The SERVER owns the wait now and
   *  re-invokes the agent when it elapses; the client only mirrors the countdown.
   *  `until` is the epoch-ms wake time (authoritative), `seconds` is the original
   *  duration (for display). */
  | { type: 'timer'; id: string; seconds: number; label: string; until?: number }
  /** The turn is PAUSED server-side on a timer (not finished). Emitted right
   *  after `timer` so an attached client can drop the connection and reattach at
   *  `until` instead of holding the stream open for hours. The task resumes on
   *  its own; no client action is required. */
  | { type: 'sleep'; until: number }
  /** This chat's workspace (notes + plan) after the assistant changed it; the
   *  client replaces its local copy so the plan/notes UI updates live. */
  | { type: 'workspace'; workspace: ChatWorkspaceDto }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** One NDJSON line on the assistant stream: the event plus its server-assigned
 *  sequence number, so a reconnecting client can ask for everything `after` the
 *  last seq it saw (reattach without replaying the whole turn). */
export interface StreamFrame {
  seq: number;
  event: AssistantEvent;
}

/** Lifecycle of a server-side agent task (one in-flight turn for a chat). */
export type TaskStatus = 'running' | 'awaiting' | 'sleeping' | 'done' | 'error';

/** What GET /api/assistant/tasks reports for a chat with a live (or just
 *  finished) server-side task — so a reloaded client can reattach. */
export interface TaskStatusDto {
  chatId: string;
  status: TaskStatus;
  /** Highest event seq emitted so far (the client reattaches with from=seq). */
  seq: number;
  /** For a sleeping task: epoch-ms it will wake and continue on its own. */
  wakeAt?: number;
}

export interface AssistantRequestBody {
  messages: ChatTurn[];
  mode?: AssistantMode;
  approval?: ApprovalLevel;
  provider?: AssistantProvider;
  model?: string;
  /** The active chat's id, so the server can load/update this chat's scratch
   *  workspace (notes + plan) and inject it into the prompt. */
  chatId?: string;
  /** Legacy toggle from before modes existed; false maps to mode "ask". */
  allowActions?: boolean;
}

// ── Per-chat workspace: scratch notes + an optional plan/checklist ───────────
// Chat-SCOPED (unlike global memory): facts and intent that matter only to this
// conversation. The assistant writes them via tools; the operator sees them and
// can clear them. Never holds secrets.

/** A short note relevant only to the current chat. */
export interface ChatNoteDto {
  id: string;
  text: string;
}

export type PlanStepStatus = 'todo' | 'doing' | 'done';

/** One step of the assistant's multi-step plan for a long task. */
export interface PlanStepDto {
  id: string;
  text: string;
  status: PlanStepStatus;
}

export interface ChatWorkspaceDto {
  notes: ChatNoteDto[];
  plan: PlanStepDto[];
}

// ── /api/assistant/models payload (key STATUS only — never key values) ───────

export interface ProviderStatus {
  id: AssistantProvider;
  label: string;
  /** Where the active key lives; null = not configured. NEVER the key itself. */
  source: 'env' | 'stored' | null;
  /** True for OpenAI-compatible providers that accept a custom base URL. */
  customBaseUrl?: boolean;
  /** The configured base URL (non-secret), shown in the key form. */
  baseUrl?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  /** Price multiplier (1x = Gemini 2.5 Flash); null = unknown → "–x" badge. */
  multiplier: number | null;
  /** Newest model of its tier (pro/flash/opus/…). The menu shows featured
   *  models up front; the rest live behind "More models". */
  featured: boolean;
}

export interface ModelsResponse {
  providers: ProviderStatus[];
  models: Partial<Record<AssistantProvider, ModelOption[]>>;
  defaults: { provider: AssistantProvider | null; model: string | null };
}

/** A note in the operator-visible assistant memory. */
export interface MemoryNoteDto {
  id: string;
  text: string;
  createdAt: string;
}
