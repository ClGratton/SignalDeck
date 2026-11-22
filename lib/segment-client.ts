// Client for the server-side segmentation proxy (/api/assistant/images/segment). No model runs in the browser.
export interface Pt { x: number; y: number; label: 0 | 1 }
export interface Embedding { key: string; width: number; height: number }
export type Box = [number, number, number, number];
const ENDPOINT = '/api/assistant/images/segment';

export async function embedImage(canvas: HTMLCanvasElement): Promise<Embedding> {
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Could not prepare the photo.');
  const form = new FormData(); form.set('image', blob, 'image.jpg');
  const res = await fetch(ENDPOINT, { method: 'POST', body: form });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || typeof d.key !== 'string') throw new Error(d.error || 'Selection service unavailable.');
  return { key: d.key, width: d.width, height: d.height };
}

const predictRaw = (key: string, points: Pt[], box: Box | null) =>
  fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, points, box }) });

/** Returns a w*h 0/1 mask. On an unknown key `reembed` is awaited once and the call retried. */
export async function predictMask(
  emb: Embedding, points: Pt[], box: Box | null, w: number, h: number, reembed: () => Promise<Embedding>,
): Promise<{ mask: Uint8Array; emb: Embedding }> {
  let cur = emb;
  let res = await predictRaw(cur.key, points, box);
  if (res.status === 404) { cur = await reembed(); res = await predictRaw(cur.key, points, box); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok || typeof d.mask !== 'string') throw new Error(d.error || 'Selection failed.');
  const bytes = Uint8Array.from(atob(d.mask), c => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
  const px = ctx.getImageData(0, 0, w, h).data; const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] > 127 ? 1 : 0; // threshold: tolerant of canvas readback noise
  return { mask: out, emb: cur };
}
