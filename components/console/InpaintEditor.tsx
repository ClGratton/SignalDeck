'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Brush, CircleMinus, Eraser, FlipHorizontal2, LoaderCircle, Sparkles, Trash2, Undo2, Wand2, X } from 'lucide-react';
import styles from './assistant.module.css';
import { embedImage, predictMask, type Box, type Embedding } from '@/lib/segment-client';
import { encodeMaskPng } from '@/lib/png-mask';

// Mirrors the relay's rules (relay.py _inpaint_prepare): 64..3072 px per side, <= 9.5 MP, mask == image size, binary mask.
const MAX_SIDE = 2048;
const MAX_MPX = 9_000_000;
const MIN_SIDE = 64;
const UNDO_LIMIT = 12;
const MASK_RGB = [255, 64, 96];
export type InpaintMode = 'recolor' | 'replace' | 'remove';
export interface InpaintParams { mode: InpaintMode; prompt: string; strength: number; grow: number; blend: number }
const DEFAULTS: Record<InpaintMode, { strength: number; grow: number; blend: number; prompt: string; ph: string }> = {
  recolor: { strength: 0.55, grow: 8, blend: 28, prompt: '', ph: 'New colour or material, e.g. red leather' },
  replace: { strength: 0.85, grow: 8, blend: 28, prompt: '', ph: 'What should appear instead' },
  remove: { strength: 1, grow: 10, blend: 28, prompt: 'empty plain background, natural texture continuing the surroundings', ph: 'What should fill the gap' },
};
type Tool = 'select' | 'subtract' | 'brush' | 'erase';
type Prep = 'preparing' | 'ready' | 'error';
const TOOLS: Array<{ id: Tool; label: string; Icon: typeof Brush }> = [
  { id: 'select', label: 'Select', Icon: Wand2 },
  { id: 'subtract', label: 'Subtract', Icon: CircleMinus },
  { id: 'brush', label: 'Brush', Icon: Brush },
  { id: 'erase', label: 'Erase', Icon: Eraser },
];

export function InpaintEditor({ source, busy, onSubmit, onCancel }: {
  source: Blob; busy: boolean; onCancel: () => void;
  onSubmit: (image: Blob, mask: Blob, params: InpaintParams) => void;
}) {
  const imgRef = useRef<HTMLCanvasElement>(null);   // photo at working resolution
  const maskRef = useRef<HTMLCanvasElement>(null);  // display of the mask (the array below is the truth)
  const prevRef = useRef<HTMLCanvasElement>(null);  // box preview + pointer surface
  const dims = useRef({ w: 0, h: 0 });
  const mask = useRef<Uint8Array>(new Uint8Array(0)); // authoritative 0/1 mask, never read back from a canvas
  const undo = useRef<Uint8Array[]>([]);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const boxDrag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const emb = useRef<Embedding | null>(null);
  const [ready, setReady] = useState(false);
  const [aspect, setAspect] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [tool, setTool] = useState<Tool>('select');
  const [size, setSize] = useState(40);
  const [mode, setMode] = useState<InpaintMode>('recolor');
  const [prompt, setPrompt] = useState('');
  const [strength, setStrength] = useState(DEFAULTS.recolor.strength);
  const [grow, setGrow] = useState(DEFAULTS.recolor.grow);
  const [blend, setBlend] = useState(DEFAULTS.recolor.blend);
  const [undoCount, setUndoCount] = useState(0);
  const [prep, setPrep] = useState<Prep>('preparing');
  const [segBusy, setSegBusy] = useState(false);

  const prepare = useCallback(async () => {
    setPrep('preparing');
    try { emb.current = await embedImage(imgRef.current!); setPrep('ready'); }
    catch (e) { emb.current = null; setPrep('error'); setNote(e instanceof Error ? `${e.message} Brush still works.` : 'Auto-select unavailable. Brush still works.'); setTool(t => (t === 'select' || t === 'subtract') ? 'brush' : t); }
  }, []);

  // Load the photo (EXIF orientation applied) at working resolution, then embed it on the server automatically.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bmp = await createImageBitmap(source, { imageOrientation: 'from-image' });
        let w = bmp.width, h = bmp.height;
        const k = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_MPX / (w * h)));
        w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        if (Math.min(w, h) < MIN_SIDE) throw new Error(`This image is too small (${w} x ${h} px). Each side must be at least ${MIN_SIDE} px.`);
        if (!alive) return;
        dims.current = { w, h }; mask.current = new Uint8Array(w * h);
        for (const c of [imgRef.current!, maskRef.current!, prevRef.current!]) { c.width = w; c.height = h; }
        const ctx = imgRef.current!.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
        setAspect(`${w} / ${h}`); setReady(true);
        void prepare();
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Could not read this image.'); }
    })();
    return () => { alive = false; };
  }, [source, prepare]);

  const paintRect = (x0: number, y0: number, x1: number, y1: number) => {
    const { w, h } = dims.current;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
    const bw = x1 - x0, bh = y1 - y0; if (bw <= 0 || bh <= 0) return;
    const ctx = maskRef.current!.getContext('2d')!; const id = ctx.createImageData(bw, bh); const m = mask.current;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (!m[(y0 + y) * w + x0 + x]) continue; const o = (y * bw + x) * 4;
      id.data[o] = MASK_RGB[0]; id.data[o + 1] = MASK_RGB[1]; id.data[o + 2] = MASK_RGB[2]; id.data[o + 3] = 255;
    }
    ctx.putImageData(id, x0, y0);
  };
  const repaintAll = () => { const { w, h } = dims.current; paintRect(0, 0, w, h); };
  const snapshot = () => { undo.current.push(mask.current.slice()); if (undo.current.length > UNDO_LIMIT) undo.current.shift(); setUndoCount(undo.current.length); };
  function doUndo() { const s = undo.current.pop(); if (!s) return; mask.current = s; setUndoCount(undo.current.length); repaintAll(); }
  function clearMask() { snapshot(); mask.current.fill(0); repaintAll(); }
  function invertMask() { snapshot(); const m = mask.current; for (let i = 0; i < m.length; i++) m[i] = m[i] ? 0 : 1; repaintAll(); }

  const toImage = (cx: number, cy: number) => {
    const r = maskRef.current!.getBoundingClientRect();
    return { x: (cx - r.left) * dims.current.w / r.width, y: (cy - r.top) * dims.current.h / r.height, scale: dims.current.w / r.width };
  };
  const stamp = (cx: number, cy: number, r: number, val: number) => {
    const { w, h } = dims.current; const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w, Math.ceil(cx + r) + 1);
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h, Math.ceil(cy + r) + 1); const r2 = r * r; const m = mask.current;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= r2) m[y * w + x] = val; }
  };
  const strokeTo = (x: number, y: number) => {
    const from = drawing.current!; const r = size / 2, val = tool === 'erase' ? 0 : 1;
    const d = Math.hypot(x - from.x, y - from.y), n = Math.max(1, Math.ceil(d / Math.max(1, r / 3)));
    for (let i = 1; i <= n; i++) stamp(from.x + (x - from.x) * i / n, from.y + (y - from.y) * i / n, r, val);
    paintRect(Math.floor(Math.min(from.x, x) - r) - 1, Math.floor(Math.min(from.y, y) - r) - 1, Math.ceil(Math.max(from.x, x) + r) + 2, Math.ceil(Math.max(from.y, y) + r) + 2);
    drawing.current = { x, y };
  };
  const paintTool = tool === 'brush' || tool === 'erase';
  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImage(e.clientX, e.clientY);
    if (!paintTool) { boxDrag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return; }
    snapshot(); drawing.current = { x: p.x, y: p.y }; stamp(p.x, p.y, size / 2, tool === 'erase' ? 0 : 1);
    paintRect(Math.floor(p.x - size / 2) - 1, Math.floor(p.y - size / 2) - 1, Math.ceil(p.x + size / 2) + 2, Math.ceil(p.y + size / 2) + 2);
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = toImage(e.clientX, e.clientY);
    if (!paintTool) { if (boxDrag.current) { boxDrag.current.x1 = p.x; boxDrag.current.y1 = p.y; drawBox(boxDrag.current); } return; }
    if (drawing.current) strokeTo(p.x, p.y);
  }
  function onUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!paintTool && boxDrag.current) {
      const b = boxDrag.current; boxDrag.current = null; clearOverlay(); const p = toImage(e.clientX, e.clientY);
      const sub = tool === 'subtract' || e.altKey || e.button === 2;
      if (Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / p.scale > 8) void segment([], [Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.max(b.x0, b.x1), Math.max(b.y0, b.y1)], sub);
      else void segment([{ x: b.x0, y: b.y0, label: 1 }], null, sub);
      return;
    }
    drawing.current = null;
  }
  const clearOverlay = () => { const c = prevRef.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); };
  function drawBox(b: { x0: number; y0: number; x1: number; y1: number }) {
    const c = prevRef.current!; const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = 'rgb(255,255,255)'; ctx.lineWidth = Math.max(2, c.width / 400); ctx.setLineDash([8, 6]); ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }
  function flashPoint(x: number, y: number) {
    const c = prevRef.current!; const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height);
    ctx.beginPath(); ctx.arc(x, y, Math.max(6, c.width / 120), 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
    window.setTimeout(clearOverlay, 450);
  }

  // Selections commit directly: every tap/box -> server predict -> OR into (or subtract from) the mask.
  async function segment(points: Array<{ x: number; y: number; label: 0 | 1 }>, box: Box | null, subtract: boolean) {
    setErr('');
    if (prep === 'preparing') { setNote('Still preparing the selection. Try again in a moment.'); return; }
    if (!emb.current) { setNote('Auto-select unavailable. Retrying…'); await prepare(); if (!emb.current) return; }
    if (segBusy) return;
    setSegBusy(true); setNote(''); if (points[0]) flashPoint(points[0].x, points[0].y);
    try {
      const { w, h } = dims.current;
      const r = await predictMask(emb.current!, points, box, w, h, async () => { const e = await embedImage(imgRef.current!); emb.current = e; return e; });
      emb.current = r.emb; snapshot(); const m = mask.current; let any = false;
      for (let i = 0; i < m.length; i++) if (r.mask[i]) { m[i] = subtract ? 0 : 1; any = true; }
      if (!any) setNote('Nothing found there. Tap the object itself or drag a box around it.');
      repaintAll();
    } catch (e) { setNote(e instanceof Error ? e.message : 'Selection failed.'); }
    finally { setSegBusy(false); }
  }

  function pickMode(m: InpaintMode) {
    setMode(m); const d = DEFAULTS[m]; setStrength(d.strength); setGrow(d.grow); setBlend(d.blend);
    setPrompt(p => (!p || Object.values(DEFAULTS).some(x => x.prompt && x.prompt === p)) ? d.prompt : p);
  }

  async function submit() {
    const { w, h } = dims.current; setErr('');
    if (Math.min(w, h) < MIN_SIDE || Math.max(w, h) > 3072 || w * h > 9_500_000) { setErr(`Image size ${w} x ${h} px is outside the allowed range (64 to 3072 px per side, 9.5 MP).`); return; }
    if (mask.current.length !== w * h) { setErr('The selection does not match the image size. Reopen the editor.'); return; }
    let any = false; for (let i = 0; i < mask.current.length; i++) if (mask.current[i]) { any = true; break; }
    if (!any) { setErr('Select something first: tap an object or paint with the brush.'); return; }
    if (!prompt.trim()) { setErr('Describe what the selected area should become.'); return; }
    // The mask is encoded straight from the array (binary, opaque, exactly image-sized), never via canvas readback.
    const maskBlob = encodeMaskPng(mask.current, w, h);
    let imgBlob = await new Promise<Blob | null>(r => imgRef.current!.toBlob(r, 'image/png'));
    if (imgBlob && imgBlob.size > 10 * 1024 * 1024) imgBlob = await new Promise<Blob | null>(r => imgRef.current!.toBlob(r, 'image/jpeg', 0.95));
    if (!imgBlob || imgBlob.size > 12 * 1024 * 1024) { setErr('The photo is too large to send even after resizing. Try a smaller one.'); return; }
    if (maskBlob.size > 4 * 1024 * 1024) { setErr('The selection is too large to send.'); return; }
    onSubmit(imgBlob, maskBlob, { mode, prompt: prompt.trim(), strength, grow, blend });
  }

  const status = prep === 'preparing' ? 'Preparing selection…' : segBusy ? 'Selecting…' : '';
  return <div className={styles.ed}>
    <div className={styles.edBar}>
      <div className={styles.edSeg} role="toolbar" aria-label="Selection tools">
        {TOOLS.map(({ id, label, Icon }) => <button key={id} type="button" aria-pressed={tool === id} disabled={prep === 'error' && (id === 'select' || id === 'subtract')} onClick={() => setTool(id)}><Icon size={16} aria-hidden /><span>{label}</span></button>)}
      </div>
      <div className={styles.edIcons}>
        <button type="button" onClick={doUndo} disabled={!undoCount} aria-label="Undo" title="Undo"><Undo2 size={16} aria-hidden /></button>
        <button type="button" onClick={invertMask} aria-label="Invert selection" title="Invert selection"><FlipHorizontal2 size={16} aria-hidden /></button>
        <button type="button" onClick={clearMask} aria-label="Clear selection" title="Clear selection"><Trash2 size={16} aria-hidden /></button>
      </div>
    </div>
    {paintTool && <label className={styles.edSize}><span>Size</span><input type="range" min={4} max={200} value={size} onChange={e => setSize(Number(e.target.value))} aria-label="Brush size" /><output>{size}</output></label>}
    <div className={styles.edStage}>
      <div className={styles.edCanvas} style={{ aspectRatio: aspect || undefined, width: dims.current.w ? `min(100%, calc(62dvh * ${dims.current.w / dims.current.h}))` : undefined, cursor: paintTool ? 'cell' : 'crosshair' }}>
        <canvas ref={imgRef} className={styles.edLayer} />
        <canvas ref={maskRef} className={`${styles.edLayer} ${styles.edMask}`} />
        <canvas ref={prevRef} className={styles.edLayer} data-testid="inpaint-surface" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={e => e.preventDefault()} />
        {!ready && !err && <span className={styles.edLoading}><LoaderCircle size={16} aria-hidden /> Loading photo</span>}
        {status && <span className={styles.edChip} role="status"><LoaderCircle size={12} aria-hidden /> {status}</span>}
      </div>
    </div>
    <div className={styles.edSeg3} role="group" aria-label="Edit type">
      {(['recolor', 'replace', 'remove'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => pickMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
    </div>
    <textarea className={styles.edPrompt} value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} rows={2} placeholder={DEFAULTS[mode].ph} aria-label="Prompt" />
    <details className={styles.edAdv}><summary>Advanced</summary>
      <label><span>Strength</span><input type="range" min={0.05} max={1} step={0.05} value={strength} onChange={e => setStrength(Number(e.target.value))} /><output>{strength.toFixed(2)}</output></label>
      <label><span>Grow</span><input type="range" min={0} max={64} value={grow} onChange={e => setGrow(Number(e.target.value))} /><output>{grow}</output></label>
      <label><span>Blend</span><input type="range" min={0} max={128} value={blend} onChange={e => setBlend(Number(e.target.value))} /><output>{blend}</output></label>
    </details>
    {note && <p role="status" className={styles.imageNote}>{note}</p>}
    {err && <p role="alert" className={styles.imageError}>{err}</p>}
    <div className={styles.edActions}>
      <button type="button" className={styles.edGo} onClick={submit} disabled={!ready || busy}>{busy ? <LoaderCircle size={16} aria-hidden /> : <Sparkles size={16} aria-hidden />}{busy ? 'Generating' : 'Generate'}</button>
      <button type="button" className={styles.edClose} onClick={onCancel} disabled={busy} aria-label="Close editor" title="Close editor"><X size={16} aria-hidden /></button>
    </div>
  </div>;
}
