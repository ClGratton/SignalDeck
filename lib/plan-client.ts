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
  const res = await fetch('/api/assistant/images/plan', { method: 'POST', body: form, signal });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'The planner is unavailable.');
  const sx = w / pw, sy = h / ph;
  const box: Box | null = Array.isArray(d.box)
    ? ([d.box[0] * sx, d.box[1] * sy, d.box[2] * sx, d.box[3] * sy].map((v: number, i: number) => Math.min(i % 2 ? h : w, Math.max(0, v))) as Box)
    : null;
  return { ...d, box };
}
