'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Brush, CircleMinus, Eraser, FlipHorizontal2, LoaderCircle, Sparkles, Trash2, Undo2, Wand2, X } from 'lucide-react';
import styles from './assistant.module.css';
import { embedImage, predictMask, type Box, type Embedding } from '@/lib/segment-client';
import { IDENTITY, clampView, gestureView, screenToImage, zoomAt, type View } from '@/lib/view-transform';
import { encodeMaskPng } from '@/lib/png-mask';
import { Button, Field } from '@/components/ui';
import type { EditOverrides, EditEngine } from '@/lib/edit-client';

// Mirrors the relay's rules (relay.py _inpaint_prepare): 64..3072 px per side, <= 9.5 MP, mask == image size, binary mask.
const MAX_SIDE = 2048;
const MAX_MPX = 9_000_000;
const MIN_SIDE = 64;
const UNDO_LIMIT = 12;
const MASK_RGB = [255, 64, 96];
export interface PlanSummary { op: string; target: string; color: string | null; prompt: string; source: 'llm' | 'fallback' }
/** What Generate sends: the words, plus optional overrides when re-running a changed plan. The server does everything else. */
export interface InpaintParams { instruction: string; overrides?: EditOverrides }
/** The one continuous stage: the editor stays mounted from Generate to the reveal and renders this in place. */
export interface RunView {
  stage: string; line: string; time: string; hint: string; plan: PlanSummary | null; maskPreview: string | null;
  resultUrl: string | null; resultOn: boolean; blur: boolean; error: string; live: boolean; final: boolean; failed: boolean; actions: ReactNode;
}
type Op3 = 'recolor' | 'replace' | 'remove';
const op3 = (op: string): Op3 => (op === 'recolor' ? 'recolor' : op === 'remove' ? 'remove' : 'replace');
const planLine = (pl: PlanSummary) => [pl.op[0].toUpperCase() + pl.op.slice(1), pl.target, pl.color].filter(Boolean).join(' \u00b7 ');
const ENGINE_OPTS: Array<{ id: EditEngine | 'auto'; label: string }> = [
  { id: 'auto', label: 'Auto' }, { id: 'kontext', label: 'Kontext' }, { id: 'fluxfill', label: 'Flux Fill' }, { id: 'sdxl', label: 'SDXL' },
];
type Tool = 'select' | 'subtract' | 'brush' | 'erase';
type Prep = 'preparing' | 'ready' | 'error';
const TOOLS: Array<{ id: Tool; label: string; Icon: typeof Brush }> = [
  { id: 'select', label: 'Select', Icon: Wand2 },
  { id: 'subtract', label: 'Subtract', Icon: CircleMinus },
  { id: 'brush', label: 'Brush', Icon: Brush },
  { id: 'erase', label: 'Erase', Icon: Eraser },
];

export function InpaintEditor({ source, busy, run, onSubmit, onCancel, onRerun }: {
  source: Blob; busy: boolean; run: RunView | null; onCancel: () => void;
  onSubmit: (image: Blob, mask: Blob | null, params: InpaintParams) => void;
  onRerun?: (overrides: EditOverrides) => void;
}) {

  const imgRef = useRef<HTMLCanvasElement>(null);   // photo at working resolution
  const maskRef = useRef<HTMLCanvasElement>(null);  // display of the mask (the array below is the truth)
  const prevRef = useRef<HTMLCanvasElement>(null);  // box preview + pointer surface
  const dims = useRef({ w: 0, h: 0 });
  const mask = useRef<Uint8Array>(new Uint8Array(0)); // authoritative 0/1 mask, never read back from a canvas
  const undo = useRef<Uint8Array[]>([]);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const boxDrag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Zoom/pan of the PICTURE only: CSS transform on a wrapper (canvases never resized).
  const viewportRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>(IDENTITY);
  const raf = useRef(0);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ t: number; moved: boolean } | null>(null);
  const lastTwoTap = useRef(0);
  const tap = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const panning = useRef<{ x: number; y: number } | null>(null);
  const spaceDown = useRef(false);
  const [zoomK, setZoomK] = useState(1);
  const emb = useRef<Embedding | null>(null);
  const [ready, setReady] = useState(false);
  const [aspect, setAspect] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [tool, setTool] = useState<Tool>('select');
  const [size, setSize] = useState(40);
  const [undoCount, setUndoCount] = useState(0);
  const [prep, setPrep] = useState<Prep>('preparing');
  const [segBusy, setSegBusy] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [engine, setEngine] = useState<EditEngine | 'auto'>('auto');
  const [changeOpen, setChangeOpen] = useState(false);
  const [chOp, setChOp] = useState<Op3>('recolor');
  const [chPrompt, setChPrompt] = useState('');
  const [chColor, setChColor] = useState('');
  const prepP = useRef<Promise<void> | null>(null);

  const prepare = useCallback((): Promise<void> => {
    const p = (async () => {
    setPrep('preparing');
    try { emb.current = await embedImage(imgRef.current!); setPrep('ready'); }
    catch (e) { emb.current = null; setPrep('error'); setNote(e instanceof Error ? `${e.message} Brush still works.` : 'Auto-select unavailable. Brush still works.'); setTool(t => (t === 'select' || t === 'subtract') ? 'brush' : t); }
    })();
    prepP.current = p; return p;
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

  const vbox = () => viewportRef.current!.getBoundingClientRect(); // untransformed: the transform sits on the child
  const toImage = (cx: number, cy: number) => screenToImage(view.current, vbox(), dims.current, cx, cy);
  const applyView = (v: View) => {
    const r = vbox(); view.current = clampView(v, r.width, r.height);
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0; const { k, tx, ty } = view.current;
      if (zoomRef.current) zoomRef.current.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
      setZoomK(Math.round(k * 100) / 100);
    });
  };
  const resetView = () => applyView(IDENTITY);
  // Brush radius in image px: constant on SCREEN while zoomed (size is the on-screen size at 1x).
  const brushR = () => size / 2 / view.current.k;
  const local = (cx: number, cy: number) => { const r = vbox(); return { x: cx - r.left, y: cy - r.top }; };
  useEffect(() => {
    const el = viewportRef.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015) * (e.deltaMode === 1 ? 16 : 1));
      applyView(zoomAt(view.current, r.width, r.height, { x: e.clientX - r.left, y: e.clientY - r.top }, f));
    };
    const stop = (e: Event) => e.preventDefault();               // Safari page-pinch
    const tm = (e: TouchEvent) => { if (e.touches.length > 1) e.preventDefault(); };
    const key = (e: KeyboardEvent) => { if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target as HTMLElement)?.tagName ?? '')) { spaceDown.current = e.type === 'keydown'; if (e.type === 'keydown' && el.matches(':hover')) e.preventDefault(); } };
    el.addEventListener('wheel', wheel, { passive: false });
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(t, stop as EventListener);
    el.addEventListener('touchmove', tm, { passive: false });
    window.addEventListener('keydown', key); window.addEventListener('keyup', key);
    return () => {
      el.removeEventListener('wheel', wheel); for (const t of ['gesturestart', 'gesturechange', 'gestureend']) el.removeEventListener(t, stop as EventListener);
      el.removeEventListener('touchmove', tm); window.removeEventListener('keydown', key); window.removeEventListener('keyup', key);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const stamp = (cx: number, cy: number, r: number, val: number) => {
    const { w, h } = dims.current; const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w, Math.ceil(cx + r) + 1);
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h, Math.ceil(cy + r) + 1); const r2 = r * r; const m = mask.current;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= r2) m[y * w + x] = val; }
  };
  const strokeTo = (x: number, y: number) => {
    const from = drawing.current!; const r = brushR(), val = tool === 'erase' ? 0 : 1;
    const d = Math.hypot(x - from.x, y - from.y), n = Math.max(1, Math.ceil(d / Math.max(1, r / 3)));
    for (let i = 1; i <= n; i++) stamp(from.x + (x - from.x) * i / n, from.y + (y - from.y) * i / n, r, val);
    paintRect(Math.floor(Math.min(from.x, x) - r) - 1, Math.floor(Math.min(from.y, y) - r) - 1, Math.ceil(Math.max(from.x, x) + r) + 2, Math.ceil(Math.max(from.y, y) + r) + 2);
    drawing.current = { x, y };
  };
  const paintTool = tool === 'brush' || tool === 'erase';
  const brushCursor = (x: number, y: number) => {
    const c = prevRef.current!; const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height);
    const k = view.current.k; ctx.setLineDash([]); ctx.lineWidth = 2 * c.width / (vbox().width * k);
    ctx.beginPath(); ctx.arc(x, y, brushR(), 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
  };
  function cancelStroke() { // a second finger arrived: undo the half-made stroke, it was the start of a pinch
    if (drawing.current) { drawing.current = null; const s = undo.current.pop(); if (s) { mask.current = s; setUndoCount(undo.current.length); repaintAll(); } }
    tap.current = null; boxDrag.current = null; clearOverlay();
  }
  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      if (touches.current.size >= 2) { if (!gesture.current) { cancelStroke(); gesture.current = { t: performance.now(), moved: false }; } return; }
    } else if (e.button === 1 || spaceDown.current) {
      e.preventDefault(); panning.current = { x: e.clientX, y: e.clientY };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ } return;
    }
    if (!ready || busy || run) return;
    if (e.pointerType !== 'touch') { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ } }
    const p = toImage(e.clientX, e.clientY);
    if (e.pointerType === 'touch' && !paintTool) { tap.current = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY }; return; } // touch: tap only, no box
    if (!paintTool) { boxDrag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return; }
    snapshot(); drawing.current = { x: p.x, y: p.y }; stamp(p.x, p.y, brushR(), tool === 'erase' ? 0 : 1);
    paintRect(Math.floor(p.x - brushR()) - 1, Math.floor(p.y - brushR()) - 1, Math.ceil(p.x + brushR()) + 2, Math.ceil(p.y + brushR()) + 2);
    brushCursor(p.x, p.y);
  }
  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) {
      const prev = [...touches.current.values()]; const ids = [...touches.current.keys()];
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture.current) {
        if (prev.length >= 2 && ids.indexOf(e.pointerId) < 2) {
          const [a0, b0] = prev; const [a1, b1] = [...touches.current.values()];
          const m0 = local((a0.x + b0.x) / 2, (a0.y + b0.y) / 2), m1 = local((a1.x + b1.x) / 2, (a1.y + b1.y) / 2);
          const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y), d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y);
          const r = vbox(); applyView(gestureView(view.current, r.width, r.height, m0, m1, d0 > 4 ? d1 / d0 : 1));
          if (Math.hypot(m1.x - m0.x, m1.y - m0.y) > 0.5 || Math.abs(d1 - d0) > 0.5) gesture.current.moved = true;
        }
        return;
      }
      if (tap.current && Math.hypot(e.clientX - tap.current.cx, e.clientY - tap.current.cy) > 10) tap.current = null;
    }
    if (panning.current) { const v = view.current; applyView({ ...v, tx: v.tx + e.clientX - panning.current.x, ty: v.ty + e.clientY - panning.current.y }); panning.current = { x: e.clientX, y: e.clientY }; return; }
    const p = toImage(e.clientX, e.clientY);
    if (!paintTool) { if (boxDrag.current) { boxDrag.current.x1 = p.x; boxDrag.current.y1 = p.y; drawBox(boxDrag.current); } return; }
    if (drawing.current) strokeTo(p.x, p.y);
    if (e.pointerType !== 'touch' || drawing.current) brushCursor(p.x, p.y);
  }
  function onUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType === 'touch') {
      touches.current.delete(e.pointerId);
      if (gesture.current) {
        if (touches.current.size === 0) { // all fingers up: a quick still two-finger tap, twice, resets the zoom
          const g = gesture.current; gesture.current = null;
          if (!g.moved && performance.now() - g.t < 350 && e.type === 'pointerup') { const n = performance.now(); if (n - lastTwoTap.current < 500) { resetView(); lastTwoTap.current = 0; } else lastTwoTap.current = n; }
        }
        return;
      }
      if (tap.current && e.type === 'pointerup') { const t = tap.current; tap.current = null; void segment([{ x: t.x, y: t.y, label: 1 }], null, tool === 'subtract'); return; }
      tap.current = null;
    }
    if (panning.current) { panning.current = null; return; }
    if (!paintTool && boxDrag.current) {
      const b = boxDrag.current; boxDrag.current = null; clearOverlay(); const p = toImage(e.clientX, e.clientY);
      const sub = tool === 'subtract' || e.altKey || e.button === 2;
      if (Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / p.scale > 8) void segment([], [Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.max(b.x0, b.x1), Math.max(b.y0, b.y1)], sub);
      else void segment([{ x: b.x0, y: b.y0, label: 1 }], null, sub);
      return;
    }
    drawing.current = null;
    if (e.pointerType === 'touch') clearOverlay();
  }
  const clearOverlay = () => { const c = prevRef.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); };
  function drawBox(b: { x0: number; y0: number; x1: number; y1: number }) {
    const c = prevRef.current!; const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = 'rgb(255,255,255)'; ctx.lineWidth = Math.max(2, c.width / 400) / view.current.k; ctx.setLineDash([8 / view.current.k, 6 / view.current.k]); ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }
  function flashPoint(x: number, y: number) {
    const c = prevRef.current!; const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, c.width, c.height);
    ctx.beginPath(); ctx.arc(x, y, Math.max(6, c.width / 120) / view.current.k, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
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

  // A run starts: the picture returns to the fitted view and the stage takes over in place (same element tree, no remount).
  const running = !!run;
  useEffect(() => { if (running) { resetView(); setErr(''); setNote(''); } else setChangeOpen(false); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const anyMask = () => { const m = mask.current; for (let i = 0; i < m.length; i++) if (m[i]) return true; return false; };
  async function submit() {
    const { w, h } = dims.current; setErr('');
    const text = instruction.trim();
    if (Math.min(w, h) < MIN_SIDE || Math.max(w, h) > 3072 || w * h > 9_500_000) { setErr(`Image size ${w} x ${h} px is outside the allowed range (64 to 3072 px per side, 9.5 MP).`); return; }
    if (mask.current.length !== w * h) { setErr('The selection does not match the image size. Reopen the editor.'); return; }
    if (text.length < 2) { setErr('Type what you want to change first, for example "make the car white".'); return; }
    // With a selection it is sent as is; without one the server finds the object itself (plan box -> segmentation).
    const maskBlob = anyMask() ? encodeMaskPng(mask.current, w, h) : null; // encoded straight from the array, never via canvas readback
    let imgBlob = await new Promise<Blob | null>(r => imgRef.current!.toBlob(r, 'image/png'));
    if (imgBlob && imgBlob.size > 10 * 1024 * 1024) imgBlob = await new Promise<Blob | null>(r => imgRef.current!.toBlob(r, 'image/jpeg', 0.95));
    if (!imgBlob || imgBlob.size > 12 * 1024 * 1024) { setErr('The photo is too large to send even after resizing. Try a smaller one.'); return; }
    if (maskBlob && maskBlob.size > 4 * 1024 * 1024) { setErr('The selection is too large to send.'); return; }
    onSubmit(imgBlob, maskBlob, engine === 'auto' ? { instruction: text } : { instruction: text, overrides: { engine } });
  }
  function openChange() {
    if (run?.plan) { setChOp(op3(run.plan.op)); setChPrompt(run.plan.prompt); setChColor(run.plan.color ?? ''); }
    setChangeOpen(o => !o);
  }
  function rerun() {
    const color = chOp === 'recolor' && chColor.trim() ? chColor.trim() : undefined;
    setChangeOpen(false);
    onRerun?.({ op: chOp, image_prompt: chPrompt.trim() || undefined, color, ...(engine === 'auto' ? {} : { engine }) });
  }

  const status = prep === 'preparing' ? 'Preparing selection…' : segBusy ? 'Selecting…' : '';
  return <div className={styles.ed} data-run={run ? run.stage : undefined} data-testid="inpaint-editor">
    <div className={styles.edCtl} data-hide={run ? true : undefined} inert={run ? true : undefined}><div>
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
    </div></div>
    <div className={styles.edStage}>
      <div ref={viewportRef} className={styles.edCanvas} data-testid="inpaint-viewport" data-blur={run?.blur || undefined} style={{ aspectRatio: aspect || undefined, width: dims.current.w ? `min(100%, calc(62dvh * ${dims.current.w / dims.current.h}))` : undefined, cursor: run ? 'default' : paintTool ? 'cell' : 'crosshair' }}>
        <div ref={zoomRef} className={styles.edZoom} data-testid="inpaint-zoom">
          <canvas ref={imgRef} className={`${styles.edLayer} ${styles.edPhoto}`} data-testid="inpaint-photo" />
          <canvas ref={maskRef} className={`${styles.edLayer} ${styles.edMask}`} data-testid="inpaint-mask" />
          <canvas ref={prevRef} className={styles.edLayer} data-testid="inpaint-surface" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={e => { if (e.pointerType !== 'touch' && !drawing.current) clearOverlay(); }} onContextMenu={e => e.preventDefault()} />
        </div>
        {run?.maskPreview && <div className={styles.edOutline} data-testid="inpaint-outline" style={{ maskImage: `url(${run.maskPreview})`, WebkitMaskImage: `url(${run.maskPreview})` }} aria-hidden />}
        {run?.live && <><div className={styles.rsGrain} aria-hidden /><div className={styles.rsShimmer} aria-hidden /></>}
        {run?.resultUrl && <img className={styles.edResult} data-on={run.resultOn || undefined} src={run.resultUrl} alt="Edited image" data-testid="inpaint-result" />}
        {run?.failed && <div className={styles.rsFail} role="alert"><p>{run.error}</p></div>}
        {!run && zoomK > 1 && <button type="button" className={styles.edFit} onClick={resetView} aria-label="Fit picture to view" title="Fit picture to view">Fit · {zoomK.toFixed(1)}×</button>}
        {!ready && !err && <span className={styles.edLoading}><LoaderCircle size={16} aria-hidden /> Loading photo</span>}
        {status && !run && <span className={styles.edChip} role="status"><LoaderCircle size={12} aria-hidden /> {status}</span>}
      </div>
    </div>
    {run && <div className={styles.edRun} data-testid="inpaint-run">
      <p className={styles.rsLine} role="status" aria-live="polite" data-testid="inpaint-line">
        <span className={styles.rsDot} data-error={run.failed || undefined} data-live={run.live || undefined} aria-hidden />
        <span>{run.failed ? 'Generation failed' : run.line}</span>
        {run.time && <span className={styles.rsTime}>{run.time}</span>}
      </p>
      {run.hint && <p className={styles.rsHint}>{run.hint}</p>}
      {run.plan && <p className={`${styles.rsPlan} ${styles.edFade}`}><span className={styles.rsPlanChip}>{planLine(run.plan)}</span>{run.plan.source === 'fallback' && <span className={styles.rsPlanNote}>basic plan</span>}</p>}
      {run.plan?.prompt && <p className={`${styles.rsPrompt} ${styles.edFade}`} title={run.plan.prompt}>{run.plan.prompt}</p>}
      {changeOpen && !run.final && <div className={styles.edPlan} role="group" aria-label="Change the plan">
        <div className={styles.edSeg3} role="group" aria-label="Edit type">
          {(['recolor', 'replace', 'remove'] as const).map(m => <button key={m} type="button" aria-pressed={chOp === m} onClick={() => setChOp(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
        </div>
        <Field as="textarea" label="Image prompt" value={chPrompt} rows={3} maxLength={4000} onChange={e => setChPrompt(e.target.value)} />
        {chOp === 'recolor' && <Field label="Colour" value={chColor} maxLength={40} hint="A colour name or a hex value such as #f4f4f2." onChange={e => setChColor(e.target.value)} />}
        <div className={styles.edPlanActions}><Button variant="ghost" onClick={() => setChangeOpen(false)}>Cancel</Button><Button variant="secondary" onClick={rerun}>Stop and re-run</Button></div>
      </div>}
      <div className={styles.rsActions}>
        {run.actions}
        {onRerun && !run.final && <button type="button" className={styles.rsGhost} aria-expanded={changeOpen} onClick={openChange}>Change</button>}
      </div>
    </div>}
    <div className={styles.edCtl} data-hide={run ? true : undefined} inert={run ? true : undefined}><div>
      <Field as="textarea" label="What should change?" className={styles.edInstr} value={instruction} rows={2} maxLength={1000} disabled={busy}
        placeholder="e.g. make the car white" hint="Plain words are enough. Select an area first, or leave it and the server finds it for you."
        onChange={e => setInstruction(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
      <div className={styles.edEngine} role="group" aria-label="Engine">
        <span className={styles.edEngineLbl} id="ed-engine-lbl">Engine</span>
        <div className={styles.edSeg} role="group" aria-labelledby="ed-engine-lbl">
          {ENGINE_OPTS.map(o => <button key={o.id} type="button" aria-pressed={engine === o.id} disabled={busy} onClick={() => setEngine(o.id)}>{o.label}</button>)}
        </div>
        <span className={styles.edEngineHint}>{engine === 'auto' ? 'Auto picks the best engine for the edit.' : 'Used for this edit only.'}</span>
      </div>
      {note && <p role="status" className={styles.imageNote}>{note}</p>}
      {err && <p role="alert" className={styles.imageError}>{err}</p>}
      <div className={styles.edActions}>
        <button type="button" className={styles.edGo} onClick={() => void submit()} disabled={!ready || busy}>{busy ? <LoaderCircle size={16} aria-hidden /> : <Sparkles size={16} aria-hidden />}{busy ? 'Starting' : 'Generate'}</button>
        <button type="button" className={styles.edClose} onClick={onCancel} disabled={busy} aria-label="Close editor" title="Close editor"><X size={16} aria-hidden /></button>
      </div>
    </div></div>
  </div>;
}
