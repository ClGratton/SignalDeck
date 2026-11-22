// Client for the server-side edit planner proxy (/api/assistant/images/plan). No model runs in the browser.
import { encodeMaskPng } from '@/lib/png-mask';
import type { Box } from '@/lib/segment-client';

export type PlanOp = 'recolor' | 'replace' | 'remove' | 'add' | 'style';
export interface Plan {
  op: PlanOp; target: string; color: string | null; image_prompt: string; negative_prompt: string;
  strength: number; grow: number; context: number; box: Box | null; confidence: number | null;
  source: 'llm' | 'fallback'; reason?: string; prefill: boolean;
}
const PLAN_MAX = 1024;
const PLAN_KEY = 'signaldeck.plan.v1';
const PLAN_RESUME_MS = 10 * 60 * 1000;
const POLL_MS = 2000;
const GIVE_UP_MS = 4 * 60 * 1000; // total budget incl. transient failures
interface SavedPlan { id: string; instruction: string; t: number }
function loadSaved(): SavedPlan | null { try { return JSON.parse(localStorage.getItem(PLAN_KEY) || 'null'); } catch { return null; } }
function store(v: SavedPlan) { try { localStorage.setItem(PLAN_KEY, JSON.stringify(v)); } catch { /* ignore */ } }
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal.aborted) return rej(new DOMException('Aborted', 'AbortError'));
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true });
});
/** Polls until done. 5xx / network errors are transient (the image host can stall while it loads the model). */
async function pollPlan(id: string, signal: AbortSignal): Promise<Omit<Plan, 'box'> & { box: number[] | null }> {
  const start = Date.now();
  for (;;) {
    let r: { state?: string; plan?: Plan; reason?: string } | null = null;
    try {
      const res = await fetch(`/api/assistant/images/plan?id=${id}`, { cache: 'no-store', signal });
      if (res.status === 401 || res.status === 400) throw new Error('Session expired. Sign in again.');
      if (res.ok) r = await res.json();
    } catch (e) {
      if (signal.aborted || (e instanceof Error && e.message.startsWith('Session'))) throw e;
    }
    if (r?.state === 'done' && r.plan) return r.plan;
    if (r?.state === 'error') { try { localStorage.removeItem(PLAN_KEY); } catch { /* ignore */ } throw new Error(r.reason || 'Planning failed.'); }
    if (Date.now() - start > GIVE_UP_MS) throw new Error('The planner took too long.');
    await sleep(POLL_MS, signal);
  }
}

/** Plans an instruction. The photo (and mask) are downscaled to <= 1024 px; the returned box is mapped back to w x h. */
export async function requestPlan(
  photo: HTMLCanvasElement, mask: Uint8Array | null, instruction: string, signal: AbortSignal,
): Promise<Plan> {
  const w = photo.width, h = photo.height, k = Math.min(1, PLAN_MAX / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * k)), ph = Math.max(1, Math.round(h * k));
  const small = document.createElement('canvas'); small.width = pw; small.height = ph;
  const ctx = small.getContext('2d')!; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(photo, 0, 0, pw, ph);
  const blob = await new Promise<Blob | null>(r => small.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Could not prepare the photo.');
  const form = new FormData(); form.set('image', blob, 'image.jpg'); form.set('instruction', instruction);
  if (mask && mask.some(v => v)) {
    const m = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) {
      const sy = Math.min(h - 1, Math.floor((y + 0.5) / k));
      for (let x = 0; x < pw; x++) m[y * pw + x] = mask[sy * w + Math.min(w - 1, Math.floor((x + 0.5) / k))];
    }
    form.set('mask', encodeMaskPng(m, pw, ph), 'mask.png');
  }
  // Async planning: POST returns {plan_id} at once, then poll (the planner takes 75-120 s; Cloudflare cuts a request at 100 s).
  // The id is kept in localStorage so a reload / re-press of the same instruction resumes the running plan instead of starting a new one.
  const saved = loadSaved();
  let id = saved && saved.instruction === instruction && Date.now() - saved.t < PLAN_RESUME_MS ? saved.id : '';
  if (!id) {
    const res = await fetch('/api/assistant/images/plan', { method: 'POST', body: form, signal });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || typeof d.plan_id !== 'string') throw new Error(d.error || 'The planner is unavailable.');
    id = d.plan_id; store({ id, instruction, t: Date.now() });
  }
  const d = await pollPlan(id, signal);
  try { localStorage.removeItem(PLAN_KEY); } catch { /* ignore */ }
  const sx = w / pw, sy = h / ph;
  const box: Box | null = Array.isArray(d.box)
    ? ([d.box[0] * sx, d.box[1] * sy, d.box[2] * sx, d.box[3] * sy].map((v: number, i: number) => Math.min(i % 2 ? h : w, Math.max(0, v))) as Box)
    : null;
  return { ...d, box };
}
