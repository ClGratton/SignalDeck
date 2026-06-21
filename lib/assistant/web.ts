// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the assistant's window to the PUBLIC internet.
//
// Structured as the standard agent pattern — SEARCH (find ranked sources) then
// FETCH (read one page as text) — behind ONE swappable backend interface, so the
// search provider can change without touching the tools, and a future VISUAL
// capability (the operator-facing dashboard browser the AI can actually SEE)
// slots in as a third method on the same boundary (see `WebBackend.view`, left
// intentionally unimplemented — there is no file/image channel to the model yet).
//
// TASSATIVE — these return TEXT ONLY. `webFetch` converts a page to markdown; it
// CANNOT see rendered layout, images, canvases, video, or anything behind a login
// or heavy JavaScript. When a page can't be read it returns { readable: false,
// reason } — the model must SAY it couldn't read it, never pretend it "saw" a
// page it only fetched as text. That readable:false path is precisely the seam
// where the future visual browser will take over.
//
// Backend = whichever search key is configured (Tavily today). The key is read
// here only (server-only) and never leaves the server. With Tavily doing BOTH
// search and extract, the dashboard box itself makes no outbound page fetch —
// Tavily does — so there is no SSRF surface from inside the LAN. (The publicHttpUrl
// guard below is belt-and-suspenders for any FUTURE backend that fetches locally.)
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { cfg } from '@/lib/service-config';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}
export interface WebSearchResponse {
  results: WebSearchResult[];
  /** Optional provider-generated direct answer (e.g. Tavily include_answer). */
  answer?: string;
}
export interface WebFetchResult {
  url: string;
  title?: string;
  /** Page content as markdown/plain text. Empty when readable=false. */
  markdown: string;
  /** False when the page couldn't be extracted as text (JS-only, login-gated,
   *  blocked, or a non-public URL). The model must surface this, not guess. */
  readable: boolean;
  reason?: string;
  truncated?: boolean;
}

interface WebBackend {
  id: string;
  search(query: string, opts: { max?: number; topic?: 'general' | 'news' }): Promise<WebSearchResponse>;
  fetch(url: string): Promise<WebFetchResult>;
  // future: view(url): Promise<WebViewResult>  // the visual dashboard browser the
  // AI can see — plugs in here once there's an image channel to the model.
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_CHARS = 12_000; // keep a fetched page from blowing the context

/** Reject non-public targets: the assistant uses lab_request/run_shell for the
 *  lab's OWN services — web_fetch is for the open internet. Also future-proofs a
 *  locally-fetching backend against SSRF into the LAN. */
function publicHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^(127\.|10\.|169\.254\.|0\.)/.test(host)) return null;
  if (/^192\.168\./.test(host)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return null;
  return u;
}

async function postJson(url: string, key: string, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// ── Tavily backend ───────────────────────────────────────────────────────────
const TAVILY_SEARCH = 'https://api.tavily.com/search';
const TAVILY_EXTRACT = 'https://api.tavily.com/extract';

function tavilyKey(): string {
  return (cfg('TAVILY_API_KEY') ?? '').trim();
}

const tavily: WebBackend = {
  id: 'tavily',
  async search(query, opts) {
    const data = (await postJson(TAVILY_SEARCH, tavilyKey(), {
      query,
      max_results: Math.min(Math.max(opts.max ?? 5, 1), 10),
      include_answer: true,
      search_depth: 'basic',
      topic: opts.topic ?? 'general',
    })) as { answer?: unknown; results?: unknown };
    const rows = Array.isArray(data.results) ? data.results : [];
    const results: WebSearchResult[] = rows.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        title: str(o.title) || str(o.url),
        url: str(o.url),
        snippet: str(o.content).slice(0, 600),
      };
    });
    return { results, answer: typeof data.answer === 'string' ? data.answer : undefined };
  },
  async fetch(url) {
    const u = publicHttpUrl(url);
    if (!u) {
      return {
        url,
        markdown: '',
        readable: false,
        reason: 'Not a public web URL (the lab\'s own/internal hosts go through lab_request or run_shell, not web_fetch).',
      };
    }
    const data = (await postJson(TAVILY_EXTRACT, tavilyKey(), { urls: [u.toString()] })) as {
      results?: unknown;
    };
    const first = Array.isArray(data.results) ? (data.results[0] as Record<string, unknown> | undefined) : undefined;
    const raw = str(first?.raw_content);
    if (!raw) {
      return {
        url: u.toString(),
        markdown: '',
        readable: false,
        reason: 'The page could not be extracted as text — it may be JavaScript-only, login-gated, or blocking automated reads.',
      };
    }
    return {
      url: u.toString(),
      title: str(first?.title) || undefined,
      markdown: raw.slice(0, MAX_PAGE_CHARS),
      readable: true,
      truncated: raw.length > MAX_PAGE_CHARS,
    };
  },
};

// ── Public surface ───────────────────────────────────────────────────────────
function backend(): WebBackend | null {
  if (tavilyKey()) return tavily;
  return null;
}

/** Whether ANY web backend is configured — gates whether the web tools are even
 *  offered to the model (and so whether the client learns the capability exists). */
export function hasWebSearch(): boolean {
  return backend() !== null;
}

export async function webSearch(
  query: string,
  opts: { max?: number; topic?: 'general' | 'news' } = {},
): Promise<WebSearchResponse> {
  const b = backend();
  if (!b) throw new Error('No web search backend configured.');
  return b.search(query, opts);
}

export async function webFetch(url: string): Promise<WebFetchResult> {
  const b = backend();
  if (!b) throw new Error('No web search backend configured.');
  return b.fetch(url);
}
