'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Brush, CircleMinus, Eraser, FlipHorizontal2, LoaderCircle, Sparkles, Trash2, Undo2, Wand2, X } from 'lucide-react';
import styles from './assistant.module.css';
import { embedImage, predictMask, type Box, type Embedding } from '@/lib/segment-client';
import { IDENTITY, clampView, gestureView, screenToImage, zoomAt, type View } from '@/lib/view-transform';
import { encodeMaskPng } from '@/lib/png-mask';
import { requestPlan, type Plan } from '@/lib/plan-client';
import { Button, Chip, Field } from '@/components/ui';

// Mirrors the relay's rules (relay.py _inpaint_prepare): 64..3072 px per side, <= 9.5 MP, mask == image size, binary mask.
const MAX_SIDE = 2048;
const MAX_MPX = 9_000_000;
const MIN_SIDE = 64;
const UNDO_LIMIT = 12;
const MASK_RGB = [255, 64, 96];
export type InpaintMode = 'recolor' | 'replace' | 'remove';
export interface PlanSummary { op: string; target: string; color: string | null; prompt: string; source: 'llm' | 'fallback' }
export interface InpaintParams {
  mode: InpaintMode; prompt: string; strength: number; grow: number; blend: number;
  context: number; recolor: string | null; negative: string; plan: PlanSummary | null;
}
type Flow = 'idle' | 'planning' | 'selecting' | 'review';
const COUNTDOWN = 5;
const fmtS = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const modeOf = (op: string): InpaintMode => (op === 'recolor' ? 'recolor' : op === 'remove' ? 'remove' : 'replace');
const cssColor = (c: string | null) => (c && typeof CSS !== 'undefined' && CSS.supports('color', c.replace(/\s+/g, '')) ? c.replace(/\s+/g, '') : null);
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
  const [mode, setMode] = useState<InpaintMode>('recolor');
  const [prompt, setPrompt] = useState('');
  const [strength, setStrength] = useState(DEFAULTS.recolor.strength);
  const [grow, setGrow] = useState(DEFAULTS.recolor.grow);
  const [blend, setBlend] = useState(DEFAULTS.recolor.blend);
  const [undoCount, setUndoCount] = useState(0);
  const [prep, setPrep] = useState<Prep>('preparing');
  const [segBusy, setSegBusy] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [flow, setFlow] = useState<Flow>('idle');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [color, setColor] = useState('');
  const [context, setContext] = useState(1.5);
  const [negative, setNegative] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [flowMs, setFlowMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const flowStart = useRef(0);
  const prepP = useRef<Promise<void> | null>(null);
  const plannedFor = useRef('');
  const working = flow === 'planning' || flow === 'selecting';

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

  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => setFlowMs(Date.now() - flowStart.current), 1000);
    setFlowMs(Date.now() - flowStart.current);
    return () => window.clearInterval(t);
  }, [working]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (count === null) return;
    if (count <= 0) { setCount(null); void submit(); return; }
    const t = window.setTimeout(() => setCount(c => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!ready || busy || working) return;
    setCount(null);
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

  function pickMode(m: InpaintMode) {
    setCount(null); setMode(m); const d = DEFAULTS[m]; setStrength(d.strength); setGrow(d.grow); setBlend(d.blend);
    setPrompt(p => (!p || Object.values(DEFAULTS).some(x => x.prompt && x.prompt === p)) ? d.prompt : p);
  }

  const anyMask = () => { const m = mask.current; for (let i = 0; i < m.length; i++) if (m[i]) return true; return false; };
  function applyPlan(pl: Plan) {
    const m = modeOf(pl.op);
    setPlan(pl); setMode(m); setPrompt(pl.image_prompt.trim() || DEFAULTS[m].prompt || instruction.trim());
    setStrength(pl.strength); setGrow(pl.grow); setBlend(28); setContext(pl.context);
    setColor(m === 'recolor' ? (pl.color ?? '') : ''); setNegative(pl.negative_prompt); setPlanOpen(false);
  }
  function cancelFlow() { abortRef.current?.abort(); setFlow('idle'); setNote(''); }
  /** Understand the instruction (local LLM), find the object when nothing is selected, then show the plan with a short auto-continue. */
  async function runInstruction() {
    const text = instruction.trim(); if (!text || working) return;
    setErr(''); setNote(''); setCount(null);
    const ac = new AbortController(); abortRef.current = ac; flowStart.current = Date.now(); setFlowMs(0); setFlow('planning');
    let pl: Plan;
    try { pl = await requestPlan(imgRef.current!, mask.current, text, ac.signal); }
    catch (e) {
      if (ac.signal.aborted) return;
      const m = mode;
      pl = { op: m, target: '', color: null, image_prompt: text, negative_prompt: '', strength: DEFAULTS[m].strength, grow: DEFAULTS[m].grow, context: 1.5, box: null, confidence: null, source: 'fallback', prefill: false,
        reason: (e instanceof Error ? e.message : 'The planner is unavailable.') + ' Your text is used as the prompt.' };
    }
    if (ac.signal.aborted) return;
    plannedFor.current = text; applyPlan(pl);
    if (!anyMask()) {
      if (!pl.box) { setFlow('idle'); setNote('Could not tell where that is. Tap the object or drag a box around it, then press Generate.'); return; }
      setFlow('selecting');
      try {
        if (!emb.current) await (prepP.current ?? prepare());
        if (!emb.current) throw new Error('Auto-select is unavailable. Paint the area with the brush, then press Generate.');
        const { w, h } = dims.current;
        const r = await predictMask(emb.current, [], pl.box, w, h, async () => { const e = await embedImage(imgRef.current!); emb.current = e; return e; });
        if (ac.signal.aborted) return;
        emb.current = r.emb; snapshot(); mask.current = r.mask.slice(); repaintAll();
        if (!anyMask()) throw new Error('Nothing was selected. Tap the object or drag a box around it, then press Generate.');
      } catch (e) { if (ac.signal.aborted) return; setFlow('idle'); setNote(e instanceof Error ? e.message : 'Selection failed.'); return; }
    }
    setFlow('review'); setCount(COUNTDOWN);
  }
  /** The one primary action: plan first when the text is new, otherwise send. */
  function go() {
    if (working) return;
    if (instruction.trim() && (flow !== 'review' || instruction.trim() !== plannedFor.current)) { void runInstruction(); return; }
    void submit();
  }

  async function submit() {
    setCount(null);
    const { w, h } = dims.current; setErr('');
    if (Math.min(w, h) < MIN_SIDE || Math.max(w, h) > 3072 || w * h > 9_500_000) { setErr(`Image size ${w} x ${h} px is outside the allowed range (64 to 3072 px per side, 9.5 MP).`); return; }
    if (mask.current.length !== w * h) { setErr('The selection does not match the image size. Reopen the editor.'); return; }
    let any = false; for (let i = 0; i < mask.current.length; i++) if (mask.current[i]) { any = true; break; }
    if (!any) { setErr('Select something first: tap an object or paint with the brush.'); return; }
    if (!prompt.trim()) { setErr('Type what you want to change first, for example "make the car white".'); return; }
    // The mask is encoded straight from the array (binary, opaque, exactly image-sized), never via canvas readback.
    const maskBlob = encodeMaskPng(mask.current, w, h);
    let imgBlob = await new Promise<Blob | null>(r => imgRef.current!.toBlob(r, 'image/png'));
    if (imgBlob && imgBlob.size > 10 * 1024 * 1024) imgBlob = await new Promise<Blob | null>(r => imgRef.current!.toBlob(r, 'image/jpeg', 0.95));
    if (!imgBlob || imgBlob.size > 12 * 1024 * 1024) { setErr('The photo is too large to send even after resizing. Try a smaller one.'); return; }
    if (maskBlob.size > 4 * 1024 * 1024) { setErr('The selection is too large to send.'); return; }
    const rc = mode === 'recolor' && color.trim() ? color.trim() : null;
    onSubmit(imgBlob, maskBlob, { mode, prompt: prompt.trim(), strength, grow, blend, context, recolor: rc, negative,
      plan: plan ? { op: mode === modeOf(plan.op) ? plan.op : mode, target: plan.target, color: rc, prompt: prompt.trim(), source: plan.source } : null });
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
      <div ref={viewportRef} className={styles.edCanvas} data-testid="inpaint-viewport" data-working={working || undefined} style={{ aspectRatio: aspect || undefined, width: dims.current.w ? `min(100%, calc(62dvh * ${dims.current.w / dims.current.h}))` : undefined, cursor: paintTool ? 'cell' : 'crosshair' }}>
        <div ref={zoomRef} className={styles.edZoom} data-testid="inpaint-zoom">
          <canvas ref={imgRef} className={styles.edLayer} />
          <canvas ref={maskRef} className={`${styles.edLayer} ${styles.edMask}`} />
          <canvas ref={prevRef} className={styles.edLayer} data-testid="inpaint-surface" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={e => { if (e.pointerType !== 'touch' && !drawing.current) clearOverlay(); }} onContextMenu={e => e.preventDefault()} />
        </div>
        {zoomK > 1 && <button type="button" className={styles.edFit} onClick={resetView} aria-label="Fit picture to view" title="Fit picture to view">Fit · {zoomK.toFixed(1)}×</button>}
        {!ready && !err && <span className={styles.edLoading}><LoaderCircle size={16} aria-hidden /> Loading photo</span>}
        {working && <div className={styles.edWork} role="status" aria-live="polite">
          <p className={styles.edWorkLine}><LoaderCircle size={16} aria-hidden /> {flow === 'planning' ? 'Understanding your request…' : 'Selecting…'}<span className={styles.edPlanMeta}>{fmtS(flowMs)}</span></p>
          {flow === 'planning' && <p className={styles.edPlanMeta}>{flowMs < 20000 ? 'Loading the local model. The first request takes about 80 seconds.' : 'Still working. The first request after idle is the slowest.'}</p>}
          <Button variant="secondary" onClick={cancelFlow}>Cancel</Button>
        </div>}
        {status && !working && <span className={styles.edChip} role="status"><LoaderCircle size={12} aria-hidden /> {status}</span>}
      </div>
    </div>
    <Field as="textarea" label="What should change?" className={styles.edInstr} value={instruction} rows={2} maxLength={1000} disabled={working}
      placeholder="e.g. make the car white" hint="Plain words are enough. A local AI works out the area and the settings."
      onChange={e => { setInstruction(e.target.value); setCount(null); }}
      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } }} />
    {plan && !working && <div className={styles.edPlan} data-review={flow === 'review' || undefined} role="group" aria-label="Edit plan">
      <div className={styles.edPlanHead}>
        <Chip tone="accent" mono>{plan.op}</Chip>
        {plan.target && <span className={styles.edPlanTarget}>{plan.target}</span>}
        {mode === 'recolor' && cssColor(color || null) && <span className={styles.edSwatch} style={{ background: cssColor(color || null)! }} title={color} aria-label={`Colour ${color}`} />}
        {mode === 'recolor' && color && <span className={styles.edPlanMeta}>{color}</span>}
        {plan.source === 'fallback' && <span className={styles.edPlanNote} title={plan.reason}>Basic plan</span>}
      </div>
      <div className={styles.edSeg3} role="group" aria-label="Edit type">
        {(['recolor', 'replace', 'remove'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => pickMode(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
      </div>
      {!planOpen && <p className={styles.edPlanPrompt}>{prompt}<span className={styles.edPlanMeta}> · strength {strength.toFixed(2)}</span></p>}
      {planOpen && <div className={styles.edPlanEdit}>
        <Field as="textarea" label="Image prompt" value={prompt} rows={3} maxLength={4000} onChange={e => { setPrompt(e.target.value); setCount(null); }} />
        {mode === 'recolor' && <Field label="Colour" value={color} maxLength={40} hint="A colour name or a hex value such as #f4f4f2. Keeps the shading." onChange={e => { setColor(e.target.value); setCount(null); }} />}
      </div>}
      {plan.source === 'fallback' && plan.reason && <p className={styles.edPlanNote}>{plan.reason}</p>}
      <div className={styles.edPlanActions}>
        {count !== null && <span className={styles.edCount} role="status">Starting in {count}s</span>}
        {count !== null && <Button variant="ghost" onClick={() => setCount(null)}>Hold</Button>}
        <Button variant="ghost" onClick={() => { setCount(null); setPlanOpen(o => !o); }} aria-expanded={planOpen}>{planOpen ? 'Done editing' : 'Edit plan'}</Button>
      </div>
    </div>}
    <details className={styles.edAdv}><summary>Advanced</summary>
      <label><span>Strength</span><input type="range" min={0.05} max={1} step={0.05} value={strength} onChange={e => { setCount(null); setStrength(Number(e.target.value)); }} /><output>{strength.toFixed(2)}</output></label>
      <label><span>Grow</span><input type="range" min={0} max={64} value={grow} onChange={e => { setCount(null); setGrow(Number(e.target.value)); }} /><output>{grow}</output></label>
      <label><span>Blend</span><input type="range" min={0} max={128} value={blend} onChange={e => { setCount(null); setBlend(Number(e.target.value)); }} /><output>{blend}</output></label>
    </details>
    {note && <p role="status" className={styles.imageNote}>{note}</p>}
    {err && <p role="alert" className={styles.imageError}>{err}</p>}
    <div className={styles.edActions}>
      <button type="button" className={styles.edGo} onClick={go} disabled={!ready || busy || working}>{busy || working ? <LoaderCircle size={16} aria-hidden /> : <Sparkles size={16} aria-hidden />}{busy ? 'Generating' : working ? 'Working' : flow === 'review' && instruction.trim() === plannedFor.current ? 'Generate now' : 'Generate'}</button>
      <button type="button" className={styles.edClose} onClick={onCancel} disabled={busy} aria-label="Close editor" title="Close editor"><X size={16} aria-hidden /></button>
    </div>
  </div>;
}
