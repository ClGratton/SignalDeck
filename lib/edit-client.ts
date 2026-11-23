// Client for the server-driven edit pipeline (/api/assistant/images/edit). The server does all the work; this only
// starts it, shows its state, and reconnects at will. No model, no segmentation and no chaining run in the browser.
/** Engines the user may pick; "Auto" sends nothing and the relay chooses. Mirrors the relay's per-request `engine` override. */
export const EDIT_ENGINES = ['kontext', 'fluxfill', 'sdxl'] as const;
export type EditEngine = (typeof EDIT_ENGINES)[number];
export interface EditOverrides { op?: 'recolor' | 'replace' | 'remove'; color?: string; image_prompt?: string; strength?: number; engine?: EditEngine }
export interface EditPlan { op: string; target: string; color: string | null; image_prompt: string; strength: number; source: 'llm' | 'fallback'; engine?: string }
export interface EditState {
  stage: 'planning' | 'selecting' | 'preparing' | 'queued' | 'generating' | 'done' | 'error' | 'cancelled';
  plan?: EditPlan; mask_preview?: string; job_id?: string; output?: { job_id: string }; error?: string; updated?: number; times?: Record<string, number>;
}
export const EDIT_API = '/api/assistant/images/edit';
export const isFinalStage = (s: string) => s === 'done' || s === 'error' || s === 'cancelled';
const BASE_MS = 2000;
const MAX_MS = 15000;

export async function startEditRequest(form: FormData): Promise<string> {
  const res = await fetch(EDIT_API, { method: 'POST', body: form });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || typeof d.edit_id !== 'string') throw new Error(d.error || 'Could not start the edit.');
  return d.edit_id;
}
export async function cancelEdit(id: string): Promise<void> {
  try { await fetch(`${EDIT_API}?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* the server may already be done */ }
}

/**
 * Polls the server state until a final stage. Paused (no requests) while the browser is offline or the page is hidden and resumed on
 * `online` / `visibilitychange`; transient errors back off exponentially. The server keeps running regardless. Returns a stop function.
 */
export function watchEdit(id: string, onState: (s: EditState) => void, onFatal: (msg: string) => void): () => void {
  let stopped = false; let wake: (() => void) | null = null; let timer: ReturnType<typeof setTimeout> | undefined;
  const ac = new AbortController();
  const ready = () => navigator.onLine !== false && document.visibilityState !== 'hidden';
  const poke = () => { if (timer) clearTimeout(timer); const w = wake; wake = null; w?.(); };
  const nap = (ms: number) => new Promise<void>(res => { wake = res; timer = setTimeout(poke, ms); });
  const park = () => new Promise<void>(res => { wake = res; });
  window.addEventListener('online', poke); window.addEventListener('offline', poke); document.addEventListener('visibilitychange', poke);
  void (async () => {
    let fails = 0;
    while (!stopped) {
      if (!ready()) { await park(); continue; }
      let delay = BASE_MS;
      try {
        const res = await fetch(`${EDIT_API}?id=${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.any([ac.signal, AbortSignal.timeout(20000)]) });
        if (res.status === 401) return onFatal('Session expired. Sign in again.');
        if (res.status === 404 || res.status === 400) return onFatal('This edit is no longer available. Start it again.');
        if (!res.ok) throw new Error('transient');
        const s = (await res.json()) as EditState;
        fails = 0; if (stopped) return; onState(s); if (isFinalStage(s.stage)) return;
      } catch { if (stopped) return; fails++; delay = Math.min(MAX_MS, BASE_MS * 2 ** fails); }
      await nap(delay);
    }
  })();
  return () => { stopped = true; ac.abort(); poke(); window.removeEventListener('online', poke); window.removeEventListener('offline', poke); document.removeEventListener('visibilitychange', poke); };
}
