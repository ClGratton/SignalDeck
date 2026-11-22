// Browser-only SAM 2.1 Hiera-Tiny (onnxruntime-web, wasm backend, runs in ORT's own worker).
// Model + runtime are self-hosted (see Dockerfile / scripts/vendor-ort.mjs). Loaded lazily, only
// when the user enables auto-select. SAM 2.1 STRETCHES the image to 1024x1024 (no padding).
const MODEL_DIR = '/models/sam2.1-tiny-f8b86bc';
const ORT_DIR = '/vendor/ort/';
const SIZE = 1024;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ort = any;
let ortPromise: Promise<Ort> | null = null;
let sessions: Promise<{ enc: any; dec: any }> | null = null;

function loadOrt(): Promise<Ort> {
  const w = window as unknown as { ort?: Ort };
  if (w.ort) return Promise.resolve(w.ort);
  if (!ortPromise) ortPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${ORT_DIR}ort.wasm.min.js`;
    s.onload = () => w.ort ? resolve(w.ort) : reject(new Error('ort missing'));
    s.onerror = () => { ortPromise = null; reject(new Error('Could not load the selection runtime.')); };
    document.head.appendChild(s);
  });
  return ortPromise;
}

async function download(url: string, onBytes: (n: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error('Could not download the selection model.');
  const total = Number(res.headers.get('content-length') ?? 0);
  const out = total ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (out && got + value.length <= out.length) out.set(value, got); else chunks.push(value);
    got += value.length; onBytes(value.length);
  }
  if (out && chunks.length === 0 && got === out.length) return out;
  const all = new Uint8Array(got); let o = 0;
  if (out) { all.set(out.subarray(0, Math.min(got, out.length))); o = Math.min(got, out.length); }
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

/** Load runtime + both models. onProgress gets 0..1 of the ~151 MB download. */
export function loadSam(onProgress: (p: number) => void) {
  if (!sessions) sessions = (async () => {
    const ort = await loadOrt();
    ort.env.wasm.wasmPaths = ORT_DIR;
    ort.env.wasm.numThreads = 1; // no cross-origin isolation (COOP/COEP) => single thread
    ort.env.wasm.proxy = true;   // run inference in ORT's worker, UI stays responsive
    const TOTAL = 134656368 + 16559905; let done = 0;
    const tick = (n: number) => { done += n; onProgress(Math.min(1, done / TOTAL)); };
    const [encBytes, decBytes] = await Promise.all([download(`${MODEL_DIR}/encoder.ort`, tick), download(`${MODEL_DIR}/decoder.onnx`, tick)]);
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const enc = await ort.InferenceSession.create(encBytes, opts);
    const dec = await ort.InferenceSession.create(decBytes, opts);
    return { enc, dec };
  })().catch(e => { sessions = null; throw e; });
  return sessions;
}

export interface SamEmbedding { feats: Record<string, unknown>; }

/** Encode once per image. `src` is any drawable (the working canvas). */
export async function encodeImage(src: CanvasImageSource): Promise<SamEmbedding> {
  const { enc } = await loadSam(() => {});
  const ort = (window as unknown as { ort: Ort }).ort;
  const c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const plane = SIZE * SIZE; const data = new Float32Array(3 * plane);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < plane; i++) for (let k = 0; k < 3; k++) data[k * plane + i] = (px[i * 4 + k] / 255 - mean[k]) / std[k];
  const input = new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]);
  const out = await enc.run({ [enc.inputNames[0]]: input });
  return { feats: out };
}

export interface SamPrompt { points: Array<{ x: number; y: number; label: 0 | 1 }>; box?: { x0: number; y0: number; x1: number; y1: number } }

/** Decode a mask for the prompt. Coordinates are in W x H image pixels. Returns W*H 0/1 bytes. */
export async function decodeMask(emb: SamEmbedding, prompt: SamPrompt, W: number, H: number): Promise<Uint8Array> {
  const { dec } = await loadSam(() => {});
  const ort = (window as unknown as { ort: Ort }).ort;
  const coords: number[] = []; const labels: number[] = [];
  if (prompt.box) {
    const b = prompt.box;
    coords.push(Math.min(b.x0, b.x1) * SIZE / W, Math.min(b.y0, b.y1) * SIZE / H, Math.max(b.x0, b.x1) * SIZE / W, Math.max(b.y0, b.y1) * SIZE / H);
    labels.push(2, 3);
  }
  for (const p of prompt.points) { coords.push(p.x * SIZE / W, p.y * SIZE / H); labels.push(p.label); }
  const n = labels.length;
  const f = emb.feats as Record<string, unknown>;
  const feed: Record<string, unknown> = {
    image_embed: f.image_embed, high_res_feats_0: f.high_res_feats_0, high_res_feats_1: f.high_res_feats_1,
    point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, n, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, n]),
    mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
    has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
  };
  const out = await dec.run(feed);
  const masks = out.masks.data as Float32Array; const iou = out.iou_predictions.data as Float32Array;
  let best = 0; for (let i = 1; i < iou.length; i++) if (iou[i] > iou[best]) best = i;
  const m = masks.subarray(best * 65536, (best + 1) * 65536);
  // bilinear upsample of 256x256 logits to W x H, threshold at 0
  const res = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(255, Math.max(0, (y + 0.5) * 256 / H - 0.5)); const y0 = Math.floor(fy), y1 = Math.min(255, y0 + 1), wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(255, Math.max(0, (x + 0.5) * 256 / W - 0.5)); const x0 = Math.floor(fx), x1 = Math.min(255, x0 + 1), wx = fx - x0;
      const v = (m[y0 * 256 + x0] * (1 - wx) + m[y0 * 256 + x1] * wx) * (1 - wy) + (m[y1 * 256 + x0] * (1 - wx) + m[y1 * 256 + x1] * wx) * wy;
      res[y * W + x] = v > 0 ? 1 : 0;
    }
  }
  return res;
}

/** Heuristic gate: skip auto-select on devices that cannot hold ~150 MB models + activations. */
export function samSupport(): { ok: boolean; note?: string } {
  if (typeof WebAssembly === 'undefined') return { ok: false, note: 'This browser has no WebAssembly support.' };
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  if (mem !== undefined && mem < 4) return { ok: false, note: 'Auto-select is off on devices with under 4 GB of memory. Paint the area with the brush instead.' };
  return { ok: true };
}
