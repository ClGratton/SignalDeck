'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Brush, Eraser, FlipHorizontal2, MousePointerClick, Trash2, Undo2, Wand2, LoaderCircle } from 'lucide-react';
import styles from './assistant.module.css';
import { decodeMask, encodeImage, loadSam, samSupport, type SamEmbedding, type SamPrompt } from '@/lib/sam-client';

const MAX_SIDE = 2048; // long-side cap: image + mask are downscaled together
const MAX_MPX = 9_000_000;
const UNDO_LIMIT = 12;
const MASK_RGB = [255, 64, 96];
export type InpaintMode = 'recolor' | 'replace' | 'remove';
export interface InpaintParams { mode: InpaintMode; prompt: string; strength: number; grow: number; blend: number }
const DEFAULTS: Record<InpaintMode, { strength: number; grow: number; blend: number; prompt: string; hint: string }> = {
  recolor: { strength: 0.55, grow: 8, blend: 28, prompt: '', hint: 'Change colour or material, keep the shape. Describe the result, e.g. "red leather, same lighting".' },
  replace: { strength: 0.85, grow: 8, blend: 28, prompt: '', hint: 'Swap the selected area for something new. Describe what should appear.' },
  remove: { strength: 1, grow: 10, blend: 28, prompt: 'empty plain background, natural texture continuing the surroundings', hint: 'Erase the selected object and fill it from the surroundings.' },
};
type Tool = 'brush' | 'eraser' | 'select';

export function InpaintEditor({ source, busy, onSubmit, onCancel }: {
  source: Blob; busy: boolean; onCancel: () => void;
  onSubmit: (image: Blob, mask: Blob, params: InpaintParams) => void;
}) {
  const imgRef = useRef<HTMLCanvasElement>(null);   // photo (working resolution)
  const maskRef = useRef<HTMLCanvasElement>(null);  // painted mask, alpha = selected
  const prevRef = useRef<HTMLCanvasElement>(null);  // auto-select preview + pointer surface
  const dims = useRef({ w: 0, h: 0 });
  const undo = useRef<Uint8Array[]>([]);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const boxDrag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const emb = useRef<SamEmbedding | null>(null);
  const [ready, setReady] = useState(false);
  const [aspect, setAspect] = useState('');
  const [err, setErr] = useState('');
  const [tool, setTool] = useState<Tool>('brush');
  const [size, setSize] = useState(40);
  const [mode, setMode] = useState<InpaintMode>('recolor');
  const [prompt, setPrompt] = useState('');
  const [strength, setStrength] = useState(DEFAULTS.recolor.strength);
  const [grow, setGrow] = useState(DEFAULTS.recolor.grow);
  const [blend, setBlend] = useState(DEFAULTS.recolor.blend);
  const [undoCount, setUndoCount] = useState(0);
  const [note, setNote] = useState('');
  const support = useRef(samSupport());
  const [samState, setSamState] = useState<'off' | 'loading' | 'encoding' | 'ready' | 'error'>('off');
  const [samProgress, setSamProgress] = useState(0);
  const [negative, setNegative] = useState(false);
  const [points, setPoints] = useState<SamPrompt['points']>([]);
  const [box, setBox] = useState<SamPrompt['box']>();
  const [preview, setPreview] = useState<Uint8Array | null>(null);
  const [deciding, setDeciding] = useState(false);

  // Load the photo (EXIF orientation applied) at working resolution.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const bmp = await createImageBitmap(source, { imageOrientation: 'from-image' });
        let w = bmp.width, h = bmp.height;
        const k = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_MPX / (w * h)));
        w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        if (w < 64 || h < 64) throw new Error('The image is too small (minimum 64 px per side).');
        if (!alive) return;
        dims.current = { w, h };
        for (const c of [imgRef.current!, maskRef.current!, prevRef.current!]) { c.width = w; c.height = h; }
        const ctx = imgRef.current!.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
        setAspect(`${w} / ${h}`); setReady(true);
        if (k < 1) setNote(`Large photo: working at ${w} x ${h} px (source and mask are scaled together).`);
      } catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Could not read this image.'); }
    })();
    return () => { alive = false; };
  }, [source]);

  const snapshot = useCallback(() => {
    const { w, h } = dims.current; const a = maskRef.current!.getContext('2d')!.getImageData(0, 0, w, h).data;
    const s = new Uint8Array(w * h); for (let i = 0; i < s.length; i++) s[i] = a[i * 4 + 3];
    undo.current.push(s); if (undo.current.length > UNDO_LIMIT) undo.current.shift(); setUndoCount(undo.current.length);
  }, []);
  const writeMask = (fn: (d: Uint8ClampedArray, o: number) => void) => {
    const { w, h } = dims.current; const ctx = maskRef.current!.getContext('2d')!; const id = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < w * h; i++) fn(id.data, i * 4);
    ctx.putImageData(id, 0, 0);
  };
  const setAlpha = (d: Uint8ClampedArray, o: number, on: boolean) => { d[o] = MASK_RGB[0]; d[o + 1] = MASK_RGB[1]; d[o + 2] = MASK_RGB[2]; d[o + 3] = on ? 255 : 0; };
  function doUndo() {
    const s = undo.current.pop(); if (!s) return; setUndoCount(undo.current.length);
    writeMask((d, o) => setAlpha(d, o, s[o / 4] > 127));
  }
  function clearMask() { snapshot(); writeMask((d, o) => setAlpha(d, o, false)); }
  function invertMask() { snapshot(); writeMask((d, o) => setAlpha(d, o, d[o + 3] < 128)); }

  const toImage = (clientX: number, clientY: number) => {
    const r = maskRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) * dims.current.w / r.width, y: (clientY - r.top) * dims.current.h / r.height, scale: dims.current.w / r.width };
  };
  const strokeTo = (x: number, y: number) => {
    const ctx = maskRef.current!.getContext('2d')!; const from = drawing.current!;
    ctx.save(); ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = `rgb(${MASK_RGB.join(',')})`; ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(x + 0.01, y); ctx.stroke(); ctx.restore();
    drawing.current = { x, y };
  };
  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImage(e.clientX, e.clientY);
    if (tool === 'select') { boxDrag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return; }
    snapshot(); drawing.current = { x: p.x, y: p.y }; strokeTo(p.x, p.y);
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = toImage(e.clientX, e.clientY);
    if (tool === 'select') { if (boxDrag.current) { boxDrag.current.x1 = p.x; boxDrag.current.y1 = p.y; drawBoxPreview(boxDrag.current); } return; }
    if (drawing.current) strokeTo(p.x, p.y);
  }
  function onUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === 'select' && boxDrag.current) {
      const b = boxDrag.current; boxDrag.current = null; const p = toImage(e.clientX, e.clientY);
      if (Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / p.scale > 8) setBox({ ...b });
      else setPoints(pts => [...pts, { x: b.x0, y: b.y0, label: (negative || e.altKey || e.button === 2) ? 0 : 1 }]);
      return;
    }
    drawing.current = null;
  }
  function drawBoxPreview(b: { x0: number; y0: number; x1: number; y1: number }) {
    const c = prevRef.current!; const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = 'rgb(255,255,255)'; ctx.lineWidth = Math.max(2, c.width / 400); ctx.setLineDash([8, 6]); ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }

  // Auto-select: recompute the preview on every prompt change.
  useEffect(() => {
    if (samState !== 'ready' || !emb.current || (!points.length && !box)) { setPreview(null); return; }
    let alive = true; setDeciding(true);
    decodeMask(emb.current, { points, box }, dims.current.w, dims.current.h)
      .then(m => { if (alive) setPreview(m); })
      .catch(() => { if (alive) setNote('Auto-select failed on this prompt.'); })
      .finally(() => { if (alive) setDeciding(false); });
    return () => { alive = false; };
  }, [points, box, samState]);
  // Draw the preview overlay and prompt points.
  useEffect(() => {
    const c = prevRef.current; if (!c || !dims.current.w) return; const { w, h } = dims.current; const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    if (preview) {
      const id = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) if (preview[i]) { id.data[i * 4] = 64; id.data[i * 4 + 1] = 160; id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = 130; }
      ctx.putImageData(id, 0, 0);
    }
    const r = Math.max(5, w / 140); ctx.lineWidth = Math.max(2, w / 500);
    for (const p of points) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = p.label ? 'rgb(40,200,90)' : 'rgb(235,60,60)'; ctx.fill(); ctx.strokeStyle = 'white'; ctx.stroke(); }
    if (box) { ctx.strokeStyle = 'white'; ctx.setLineDash([8, 6]); ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0); ctx.setLineDash([]); }
  }, [preview, points, box]);
  function resetSelect() { setPoints([]); setBox(undefined); setPreview(null); }
  function commit(add: boolean) {
    if (!preview) return; snapshot();
    writeMask((d, o) => { if (preview[o / 4]) setAlpha(d, o, add); });
    resetSelect();
  }
  async function enableSam() {
    setSamState('loading'); setSamProgress(0); setNote('');
    try {
      await loadSam(setSamProgress); setSamState('encoding');
      emb.current = await encodeImage(imgRef.current!); setSamState('ready'); setTool('select');
    } catch (e) { setSamState('error'); setNote(e instanceof Error ? e.message : 'Auto-select could not start.'); }
  }

  function pickMode(m: InpaintMode) {
    setMode(m); const d = DEFAULTS[m]; setStrength(d.strength); setGrow(d.grow); setBlend(d.blend);
    setPrompt(p => (!p || Object.values(DEFAULTS).some(x => x.prompt && x.prompt === p)) ? d.prompt : p);
  }

  async function submit() {
    const { w, h } = dims.current; setErr('');
    const m = maskRef.current!.getContext('2d')!.getImageData(0, 0, w, h);
    const out = new ImageData(w, h); let any = false;
    for (let i = 0; i < w * h; i++) {
      const on = m.data[i * 4 + 3] >= 128; if (on) any = true; const v = on ? 255 : 0;
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255; // hard 0/255, opaque
    }
    if (!any) { setErr('Select the area to change first (brush or auto-select).'); return; }
    if (!prompt.trim()) { setErr('Describe what the selected area should become.'); return; }
    const mc = document.createElement('canvas'); mc.width = w; mc.height = h; mc.getContext('2d')!.putImageData(out, 0, 0);
    const maskBlob = await new Promise<Blob | null>(r => mc.toBlob(r, 'image/png'));
    let imgBlob = await new Promise<Blob | null>(r => imgRef.current!.toBlob(r, 'image/png'));
    if (imgBlob && imgBlob.size > 10 * 1024 * 1024) imgBlob = await new Promise<Blob | null>(r => imgRef.current!.toBlob(r, 'image/jpeg', 0.95));
    if (!maskBlob || !imgBlob || imgBlob.size > 12 * 1024 * 1024 || maskBlob.size > 4 * 1024 * 1024) { setErr('The photo is too large to send. Try a smaller one.'); return; }
    onSubmit(imgBlob, maskBlob, { mode, prompt: prompt.trim(), strength, grow, blend });
  }

  const samBusy = samState === 'loading' || samState === 'encoding';
  return <div className={styles.inpaint}>
    <div className={styles.inpaintTools} role="toolbar" aria-label="Selection tools">
      <button type="button" aria-pressed={tool === 'brush'} onClick={() => setTool('brush')}><Brush size={14} aria-hidden /> Brush</button>
      <button type="button" aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}><Eraser size={14} aria-hidden /> Eraser</button>
      <button type="button" aria-pressed={tool === 'select'} disabled={samState !== 'ready'} onClick={() => setTool('select')}><MousePointerClick size={14} aria-hidden /> Auto-select</button>
      <button type="button" onClick={doUndo} disabled={!undoCount}><Undo2 size={14} aria-hidden /> Undo</button>
      <button type="button" onClick={invertMask}><FlipHorizontal2 size={14} aria-hidden /> Invert</button>
      <button type="button" onClick={clearMask}><Trash2 size={14} aria-hidden /> Clear</button>
      <label className={styles.inpaintSize}>Size <input type="range" min={4} max={200} value={size} onChange={e => setSize(Number(e.target.value))} aria-label="Brush size" /><output>{size}</output></label>
    </div>
    <div className={styles.inpaintStage}>
      <div className={styles.inpaintCanvasWrap} style={{ aspectRatio: aspect || undefined, width: dims.current.w ? `min(100%, calc(70vh * ${dims.current.w / dims.current.h}))` : undefined, cursor: tool === 'select' ? 'crosshair' : 'cell' }}>
        <canvas ref={imgRef} className={styles.inpaintLayer} />
        <canvas ref={maskRef} className={`${styles.inpaintLayer} ${styles.inpaintMask}`} />
        <canvas ref={prevRef} className={styles.inpaintLayer} data-testid="inpaint-surface" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onContextMenu={e => { e.preventDefault(); if (tool === 'select' && samState === 'ready') { const p = toImage(e.clientX, e.clientY); setPoints(pts => [...pts, { x: p.x, y: p.y, label: 0 }]); } }} />
        {!ready && !err && <span className={styles.inpaintLoading}><LoaderCircle size={16} aria-hidden /> Loading photo</span>}
      </div>
    </div>
    <div className={styles.inpaintAuto}>
      {!support.current.ok ? <p className={styles.imageNote}>{support.current.note}</p>
        : samState === 'off' || samState === 'error' ? <button type="button" onClick={enableSam} disabled={!ready}><Wand2 size={14} aria-hidden /> Enable auto-select (one-time ~150 MB download)</button>
        : samBusy ? <p role="status" className={styles.imageNote}><LoaderCircle size={13} aria-hidden /> {samState === 'loading' ? `Downloading selection model ${Math.round(samProgress * 100)}%` : 'Analysing the photo'}</p>
        : <>
          <label className={styles.inpaintToggle}><input type="checkbox" checked={negative} onChange={e => setNegative(e.target.checked)} /> Exclude points (or right-click / Alt-click)</label>
          <button type="button" disabled={!preview || deciding} onClick={() => commit(true)}>Add to selection</button>
          <button type="button" disabled={!preview || deciding} onClick={() => commit(false)}>Remove from selection</button>
          <button type="button" disabled={!points.length && !box} onClick={resetSelect}>Reset points</button>
          <span className={styles.imageNote}>{tool === 'select' ? 'Click an object, or drag a box. Green adds, red excludes.' : 'Switch to Auto-select to click objects.'}</span>
        </>}
    </div>
    <fieldset className={styles.inpaintModes}><legend>Edit type</legend>
      {(['recolor', 'replace', 'remove'] as const).map(m => <label key={m}><input type="radio" name="inpaint-mode" checked={mode === m} onChange={() => pickMode(m)} /> {m[0].toUpperCase() + m.slice(1)}</label>)}
    </fieldset>
    <p className={styles.imageNote}>{DEFAULTS[mode].hint}</p>
    <label htmlFor="inpaint-prompt">Prompt</label>
    <textarea id="inpaint-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} rows={3} placeholder={mode === 'remove' ? 'What should fill the gap' : 'What the selected area should look like'} />
    <details className={styles.inpaintAdv}><summary>Advanced</summary>
      <label>Strength <input type="range" min={0.05} max={1} step={0.05} value={strength} onChange={e => setStrength(Number(e.target.value))} /><output>{strength.toFixed(2)}</output></label>
      <label>Grow edge (px) <input type="range" min={0} max={64} value={grow} onChange={e => setGrow(Number(e.target.value))} /><output>{grow}</output></label>
      <label>Blend (px) <input type="range" min={0} max={128} value={blend} onChange={e => setBlend(Number(e.target.value))} /><output>{blend}</output></label>
    </details>
    {note && <p role="status" className={styles.imageNote}>{note}</p>}
    {err && <p role="alert" className={styles.imageError}>{err}</p>}
    <div className={styles.inpaintActions}>
      <button type="button" className={styles.inpaintGo} onClick={submit} disabled={!ready || busy}>{busy ? 'Generating' : 'Generate edit'}</button>
      <button type="button" onClick={onCancel} disabled={busy}>Close editor</button>
    </div>
  </div>;
}
