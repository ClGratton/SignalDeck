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
  /** Agent mode: progress of an inline action (auto-run or post-confirm). */
  | { type: 'action'; id: string; title: string; status: ActionStatus; detail?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AssistantRequestBody {
  messages: ChatTurn[];
  mode?: AssistantMode;
  approval?: ApprovalLevel;
  provider?: AssistantProvider;
  model?: string;
  /** Legacy toggle from before modes existed; false maps to mode "ask". */
  allowActions?: boolean;
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
