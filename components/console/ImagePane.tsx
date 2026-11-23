'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Download, ImagePlus, Pencil, Plus, RotateCcw, Scaling, Square, X } from 'lucide-react';
import styles from './assistant.module.css';
import { InpaintEditor, type InpaintParams, type PlanSummary, type RunView } from './InpaintEditor';
import { cancelEdit, startEditRequest, watchEdit, type EditPlan, type EditOverrides } from '@/lib/edit-client';

const JOB_KEY = 'grtlabs.imageJob';
const JOB_MAX_MS = 30 * 60 * 1000;
const API = '/api/assistant/images';
type Kind = 'create' | 'edit';
type Phase = 'queued' | 'running' | 'loading' | 'finishing' | 'revealing' | 'done' | 'error';
// For an edit, `id` is the server's edit_id (the server drives the whole pipeline); for a plain generation it is the job id.
interface Saved { id: string; ts: number; prompt: string; kind: Kind; thumb: string | null; ar: number; plan?: PlanSummary | null; edit?: boolean }
const planLine = (pl: PlanSummary | null | undefined) => pl ? [pl.op[0].toUpperCase() + pl.op.slice(1), pl.target, pl.color].filter(Boolean).join(' · ') : '';

const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const summary = (p: EditPlan | null): PlanSummary | null => p ? { op: p.op, target: p.target, color: p.color, prompt: p.image_prompt, source: p.source, engine: p.engine } : null;

/** Small JPEG data URL of the clean source photo (no mask overlay), kept so a reload can show the blurred stage. */
async function makeThumb(blob: Blob): Promise<{ url: string; ar: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const ar = bmp.width / bmp.height; bmp.close();
    return { url: c.toDataURL('image/jpeg', 0.7), ar };
  } catch { return null; }
}

const PHASE_LABEL: Record<string, string> = {
  queued: 'Queued', running: 'Generating', loading: 'Loading model', finishing: 'Finishing', revealing: 'Done', done: 'Done',
};
const STAGE_LINE: Record<string, string> = {
  planning: 'Understanding your request…', preparing: 'Preparing the edit…', queued: 'Queued…', generating: 'Generating',
};

export function ImagePane({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [img2img, setImg2img] = useState(false);
  const [inpaint, setInpaint] = useState(false);
  const [editSource, setEditSource] = useState<Blob | null>(null);
  const [unavailable, setUnavailable] = useState('Image generation is not configured yet.');
  const [prompt, setPrompt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // Result stage
  const [stage, setStage] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('queued');
  const [kind, setKind] = useState<Kind>('create');
  const [stagePrompt, setStagePrompt] = useState('');
  const [stagePlan, setStagePlan] = useState<PlanSummary | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [ar, setAr] = useState(1);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [compare, setCompare] = useState(false);
  const [err, setErr] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [count, setCount] = useState(0);
  // Server-driven edit state: a read-replica of GET /edit/{id}.
  const [editId, setEditId] = useState<string | null>(null);
  const [estage, setEstage] = useState('planning');
  const [editPlan, setEditPlan] = useState<EditPlan | null>(null);
  const [maskPrev, setMaskPrev] = useState<string | null>(null);
  const startedRef = useRef(0);
  const lastForm = useRef<{ form: FormData; kind: Kind; thumb: string | null; ar: number; plan: PlanSummary | null } | null>(null);
  const lastEdit = useRef<{ image: Blob; mask: Blob | null; p: InpaintParams } | null>(null);
  const urlRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const polling = phase === 'queued' || phase === 'running' || phase === 'loading';
  const live = polling || phase === 'finishing';

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const check = () => { void fetch(API, { cache: 'no-store' }).then(r => r.json()).then(d => {
      if (active) { setConfigured(!!d.configured); setImg2img(!!d.img2img); setInpaint(!!d.inpaint); setUnavailable(d.reason || 'Image generation is unavailable.'); }
    }).catch(() => { if (active) { setConfigured(false); setUnavailable('Image service is unavailable.'); } }); };
    check();
    const timer = window.setInterval(check, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [visible]);

  // Resume after a reload / pane remount. An edit resumes from the server's state (it kept running without us) into the same stage view;
  // a plain generation resumes its job poll.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(JOB_KEY) || 'null') as Saved | null;
      if (saved?.id && Date.now() - saved.ts < JOB_MAX_MS) {
        startedRef.current = saved.ts; setKind(saved.kind ?? 'create'); setStagePrompt(saved.prompt ?? ''); setPrompt(saved.prompt ?? '');
        setThumb(saved.thumb ?? null); setAr(saved.ar || 1); setStagePlan(saved.plan ?? null); setStage(true);
        if (saved.edit) {
          setEditId(saved.id); setPhase('running');
          if (saved.thumb) void fetch(saved.thumb).then(r => r.blob()).then(setEditSource).catch(() => { /* fall back to the plain stage */ });
        } else { setJob(saved.id); setPhase('queued'); }
      } else localStorage.removeItem(JOB_KEY);
    } catch { /* storage unavailable */ }
  }, []);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  useEffect(() => {
    if (!stage || !live) return;
    const t = window.setInterval(() => setElapsed(Date.now() - startedRef.current), 1000);
    setElapsed(Date.now() - startedRef.current);
    return () => window.clearInterval(t);
  }, [stage, live]);

  // Preload the finished image, then reveal it (never show a half-decoded image).
  const reveal = useCallback(async (id: string) => {
    setPhase('finishing');
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(id)}&image=0`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load the finished image.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const img = new Image(); img.src = url; await img.decode();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url; setAr(img.naturalWidth / img.naturalHeight); setResultUrl(url); setRevealed(false); setPhase('revealing');
      requestAnimationFrame(() => requestAnimationFrame(() => setRevealed(true)));
      window.setTimeout(() => setPhase(p => (p === 'revealing' ? 'done' : p)), reducedMotion() ? 250 : 900);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the finished image.'); setPhase('error'); }
  }, []);

  // Plain generation: poll the job.
  useEffect(() => {
    if (!stage || !job || !polling) return;
    let active = true;
    const clear = () => { try { localStorage.removeItem(JOB_KEY); } catch { /* ignore */ } };
    const poll = async () => {
      try {
        const res = await fetch(`${API}?id=${encodeURIComponent(job)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        // 5xx / network errors are transient (the image host can stall for minutes while it loads the model).
        if (res.status >= 500) throw new Error('transient');
        if (!res.ok || data.status === 'error') { setErr(data.error || 'Generation failed.'); setPhase('error'); clear(); }
        else if (data.status === 'complete') { active = false; setCount(data.count); clear(); void reveal(job); }
        else setPhase(p => (p === 'queued' || p === 'loading' ? 'running' : p));
      } catch {
        if (!active) return;
        setPhase(p => (p === 'queued' || p === 'running' ? 'loading' : p));
        if (Date.now() - startedRef.current > JOB_MAX_MS) { setErr('Image generation timed out. Please try again.'); setPhase('error'); clear(); }
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [stage, job, polling, reveal]);

  // Edit: mirror the server's state. The server plans, selects, prepares and generates on its own; closing the tab loses nothing.
  useEffect(() => {
    if (!editId) return;
    const clear = () => { try { localStorage.removeItem(JOB_KEY); } catch { /* ignore */ } };
    return watchEdit(editId, s => {
      setEstage(s.stage);
      if (s.plan) setEditPlan(s.plan);
      if (s.mask_preview) setMaskPrev(s.mask_preview);
      if (s.stage === 'done' && s.output?.job_id) { clear(); setJob(s.output.job_id); void reveal(s.output.job_id); }
      else if (s.stage === 'error') { clear(); setErr(s.error || 'The edit failed.'); setPhase('error'); }
      else if (s.stage === 'cancelled') clear();
      else setPhase(p => (p === 'queued' || p === 'loading' ? 'running' : p));
    }, msg => { clear(); setErr(msg); setPhase('error'); });
  }, [editId, reveal]);

  async function startJob(form: FormData, k: Kind, th: string | null, ratio: number, plan: PlanSummary | null = null) {
    lastForm.current = { form, kind: k, thumb: th, ar: ratio, plan };
    setStagePlan(plan);
    const p = String(form.get('prompt') ?? '');
    setErr(''); setCount(0); setJob(null); setEditId(null); setResultUrl(null); setRevealed(false); setCompare(false);
    setKind(k); setThumb(th); setAr(ratio); setStagePrompt(p); setElapsed(0); setPhase('queued'); setStage(true); setEditSource(null);
    startedRef.current = Date.now();
    try {
      const res = await fetch(API, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start generation.');
      startedRef.current = Date.now();
      const saved: Saved = { id: data.id, ts: startedRef.current, prompt: p, kind: k, thumb: th, ar: ratio, plan };
      try { localStorage.setItem(JOB_KEY, JSON.stringify(saved)); }
      catch { try { localStorage.setItem(JOB_KEY, JSON.stringify({ ...saved, thumb: null })); } catch { /* ignore */ } }
      setJob(data.id);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not start generation.'); setPhase('error'); }
  }
  async function generate(event: FormEvent) {
    event.preventDefault();
    const form = new FormData(); form.set('prompt', prompt); if (file) form.set('image', file);
    const t = file ? await makeThumb(file) : null;
    void startJob(form, file ? 'edit' : 'create', t?.url ?? null, t?.ar ?? 1);
  }
  /** One POST; from here the server owns the pipeline. The editor stays mounted and becomes the stage. */
  async function startEdit(image: Blob, mask: Blob | null, p: InpaintParams) {
    lastEdit.current = { image, mask, p };
    const form = new FormData();
    form.set('instruction', p.instruction);
    form.set('image', image, image.type === 'image/png' ? 'source.png' : 'source.jpg');
    if (mask) form.set('mask', mask, 'mask.png');
    if (p.overrides) form.set('overrides', JSON.stringify(p.overrides));
    setErr(''); setCount(0); setJob(null); setEditId(null); setResultUrl(null); setRevealed(false); setCompare(false); setEditPlan(null); setMaskPrev(null);
    setEstage('planning'); setKind('edit'); setStagePrompt(p.instruction); setStagePlan(null); setElapsed(0); setPhase('running'); setStage(true);
    startedRef.current = Date.now();
    const th = makeThumb(image); // the clean photo: never the red mask overlay
    try {
      const id = await startEditRequest(form);
      const t = await th; setThumb(t?.url ?? null); if (t) setAr(t.ar);
      const saved: Saved = { id, ts: startedRef.current, prompt: p.instruction, kind: 'edit', thumb: t?.url ?? null, ar: t?.ar ?? 1, edit: true };
      try { localStorage.setItem(JOB_KEY, JSON.stringify(saved)); }
      catch { try { localStorage.setItem(JOB_KEY, JSON.stringify({ ...saved, thumb: null })); } catch { /* ignore */ } }
      setEditId(id);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not start the edit.'); setPhase('error'); }
  }
  function endRun() {
    try { localStorage.removeItem(JOB_KEY); } catch { /* ignore */ }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setStage(false); setEditId(null); setJob(null); setResultUrl(null); setRevealed(false); setCompare(false); setErr(''); setPhase('queued'); setEditPlan(null); setMaskPrev(null);
  }
  /** Stop and go back to the editor (the same mounted editor un-blurs and its controls return). */
  function stopEdit() { const id = editId; endRun(); if (id) void cancelEdit(id); }
  /** Change the plan: cancel the running edit and start a new one with overrides (no modal; same stage). */
  function rerun(ov: EditOverrides) {
    const l = lastEdit.current; if (!l) return;
    if (editId) void cancelEdit(editId);
    void startEdit(l.image, l.mask, { instruction: l.p.instruction, overrides: ov });
  }
  async function editResult() {
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(job ?? '')}&image=0`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load that image.');
      const blob = await res.blob();
      endRun(); setEditSource(blob);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load that image.'); setPhase('error'); }
  }
  function leave(clearPrompt: boolean) {
    endRun(); setEditSource(null); setFile(null);
    if (clearPrompt) setPrompt('');
  }
  function retry() {
    if (kind === 'edit') {
      const l = lastEdit.current;
      if (l) void startEdit(l.image, l.mask, l.p); else leave(false);
      return;
    }
    const l = lastForm.current;
    if (l) void startJob(l.form, l.kind, l.thumb, l.ar, l.plan); else leave(false);
  }

  const showBlur = phase !== 'done' && !(phase === 'revealing' && revealed);
  const status = PHASE_LABEL[phase] ?? '';
  const dlHref = job ? `${API}?id=${encodeURIComponent(job)}&image=0` : '#';
  const compareBtn = <button type="button" className={styles.rsGhost} aria-pressed={compare}
    onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)} onPointerCancel={() => setCompare(false)}
    onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompare(true); } }} onKeyUp={() => setCompare(false)} onBlur={() => setCompare(false)}><Scaling size={16} aria-hidden /> Hold to compare</button>;

  // The single stage for an edit: the editor renders this in place of its controls.
  const runView: RunView | null = stage && kind === 'edit' && editSource ? (() => {
    const plan = summary(editPlan);
    const sk = phase === 'error' ? 'error' : phase === 'finishing' || phase === 'revealing' || phase === 'done' ? phase : estage;
    const line = phase === 'finishing' ? 'Finishing…' : phase === 'revealing' || phase === 'done' ? 'Done'
      : estage === 'selecting' ? `Selecting ${editPlan?.target || 'the area'}…` : STAGE_LINE[estage] ?? 'Working…';
    const hint = !live ? '' : estage === 'planning' ? (elapsed < 20000 ? 'Loading the local model. The first request takes about 80 seconds.' : 'Still working. It keeps going on the server if you close this.')
      : estage === 'generating' ? 'Usually 4 to 5 minutes. You can leave this open or reload; it keeps going.' : '';
    const final = phase === 'done' || phase === 'revealing';
    return {
      stage: sk, line, time: live ? fmt(elapsed) : '', hint, plan, final, live, failed: phase === 'error', error: err,
      maskPreview: maskPrev && live && ['preparing', 'queued', 'generating'].includes(estage) && phase !== 'finishing' ? maskPrev : null,
      resultUrl, resultOn: revealed && !compare, blur: showBlur && !compare,
      actions: phase === 'error' ? <>
        <button type="button" className={styles.rsPrimary} onClick={retry}><RotateCcw size={16} aria-hidden /> Retry</button>
        <button type="button" className={styles.rsGhost} onClick={() => leave(false)}><ArrowLeft size={16} aria-hidden /> Back to create</button></>
        : final ? <>
          {inpaint && <button type="button" className={styles.rsPrimary} onClick={() => void editResult()}><Pencil size={16} aria-hidden /> Edit again</button>}
          <a className={styles.rsGhost} href={dlHref} download={`generated-${job?.slice(0, 8) ?? 'image'}.png`}><Download size={16} aria-hidden /> Download</a>
          {compareBtn}
          <button type="button" className={styles.rsGhost} onClick={() => leave(false)}><ArrowLeft size={16} aria-hidden /> Back to create</button>
          <button type="button" className={styles.rsGhost} onClick={() => leave(true)}><Plus size={16} aria-hidden /> New</button></>
        : <button type="button" className={styles.rsGhost} onClick={stopEdit}><Square size={14} aria-hidden /> Stop</button>,
    };
  })() : null;

  return <section className={`${styles.browserPane} ${styles.imagePane}`} style={{ display: visible ? undefined : 'none' }} aria-label="Image generation">
    <header className={styles.imageHeader}><span className={styles.imageTitle}>Image generation</span><button type="button" className={styles.browserPaneClose} onClick={onClose} aria-label="Close image generation"><X size={16}/></button></header>
    <div className={styles.imageContent}>
      {editSource && <InpaintEditor key={editSource.size + ':' + ((editSource as File).lastModified ?? 0)} source={editSource} busy={false} run={runView}
        onSubmit={(i, m, p) => void startEdit(i, m, p)} onCancel={() => setEditSource(null)} onRerun={lastEdit.current ? ov => rerun(ov) : undefined} />}
      {!editSource && stage && <div className={styles.rs} data-phase={phase} style={{ ['--ar' as string]: ar }}>
        <div className={styles.rsStatus}>
          <p className={styles.rsLine} role="status" aria-live="polite">
            <span className={styles.rsDot} data-error={phase === 'error' || undefined} data-live={live || undefined} aria-hidden />
            <span>{phase === 'error' ? 'Generation failed' : status}</span>
            {live && <span className={styles.rsTime}>{fmt(elapsed)}</span>}
          </p>
          {live && <p className={styles.rsHint}>{elapsed < 8000 && phase === 'queued' ? 'Sending to the image server.' : phase === 'loading' ? 'The image server is loading the model. It keeps running if you close this.' : 'Usually 4 to 5 minutes. You can leave this open or reload; it keeps going.'}</p>}
        </div>
        <div className={styles.rsFrame} data-err={phase === 'error' || undefined}>
          {thumb ? <img className={styles.rsSrc} data-blur={showBlur || undefined} src={thumb} alt="" /> : <div className={styles.rsPlaceholder} data-live={live || undefined} aria-hidden />}
          {live && <div className={styles.rsGrain} aria-hidden />}
          {live && <div className={styles.rsShimmer} aria-hidden />}
          {resultUrl && <img className={styles.rsResult} data-on={(revealed && !compare) || undefined} src={resultUrl} alt={stagePrompt ? `Generated image: ${stagePrompt}` : 'Generated image'} />}
          {phase === 'error' && <div className={styles.rsFail} role="alert"><p>{err}</p></div>}
        </div>
        {stagePlan && <p className={styles.rsPlan}><span className={styles.rsPlanChip}>{planLine(stagePlan)}</span>{stagePlan.source === 'fallback' && <span className={styles.rsPlanNote}>basic plan</span>}</p>}
        {stagePrompt && <p className={styles.rsPrompt} title={stagePrompt}>{stagePrompt}</p>}
        <div className={styles.rsActions}>
          {phase === 'error' && <><button type="button" className={styles.rsPrimary} onClick={retry}><RotateCcw size={16} aria-hidden /> Retry</button><button type="button" className={styles.rsGhost} onClick={() => leave(false)}><ArrowLeft size={16} aria-hidden /> Back to create</button></>}
          {(phase === 'done' || phase === 'revealing') && <>
            {inpaint && <button type="button" className={styles.rsPrimary} onClick={() => void editResult()}><Pencil size={16} aria-hidden /> Edit again</button>}
            <a className={styles.rsGhost} href={dlHref} download={`generated-${job?.slice(0, 8) ?? 'image'}.png`}><Download size={16} aria-hidden /> Download</a>
            {kind === 'edit' && thumb && compareBtn}
            <button type="button" className={styles.rsGhost} onClick={() => leave(false)}><ArrowLeft size={16} aria-hidden /> Back to create</button>
            <button type="button" className={styles.rsGhost} onClick={() => leave(true)}><Plus size={16} aria-hidden /> New</button>
          </>}
        </div>
        {count > 1 && phase === 'done' && <p className={styles.imageNote}>The server returned {count} images; showing the first.</p>}
      </div>}
      {!editSource && !stage && <form onSubmit={e => void generate(e)} className={styles.imageForm}>
        <label htmlFor="image-prompt">Prompt</label>
        <textarea id="image-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} placeholder="Describe the image you want to create" rows={4} />
        <div className={styles.imageRow}>
          <button type="submit" disabled={!configured || !prompt.trim() || (!!file && !inpaint && !img2img)}>Generate</button>
          {inpaint
            ? <label className={styles.imagePick}><ImagePlus size={16} aria-hidden /> Upload to edit<input ref={editInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) setEditSource(f); e.target.value = ''; }} /></label>
            : img2img && <label className={styles.imagePick}><ImagePlus size={16} aria-hidden /> {file ? file.name : 'Base image'}<input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>}
        </div>
        {configured === false && <p role="status" className={styles.imageNote}>{unavailable}</p>}
      </form>}
    </div>
  </section>;
}
