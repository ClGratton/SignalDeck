'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Download, ImagePlus, Pencil, Plus, RotateCcw, Scaling, X } from 'lucide-react';
import styles from './assistant.module.css';
import { InpaintEditor, type InpaintParams } from './InpaintEditor';

const JOB_KEY = 'grtlabs.imageJob';
const JOB_MAX_MS = 30 * 60 * 1000;
const API = '/api/assistant/images';
type Kind = 'create' | 'edit';
type Phase = 'queued' | 'running' | 'loading' | 'finishing' | 'revealing' | 'done' | 'error';
interface Saved { id: string; ts: number; prompt: string; kind: Kind; thumb: string | null; ar: number }

const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  const [thumb, setThumb] = useState<string | null>(null);
  const [ar, setAr] = useState(1);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [compare, setCompare] = useState(false);
  const [err, setErr] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [count, setCount] = useState(0);
  const startedRef = useRef(0);
  const lastForm = useRef<{ form: FormData; kind: Kind; thumb: string | null; ar: number } | null>(null);
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

  // Resume a job started before a reload / pane remount: restores the result stage and keeps polling.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(JOB_KEY) || 'null') as Saved | null;
      if (saved?.id && Date.now() - saved.ts < JOB_MAX_MS) {
        startedRef.current = saved.ts; setJob(saved.id); setKind(saved.kind ?? 'create'); setStagePrompt(saved.prompt ?? ''); setPrompt(saved.prompt ?? '');
        setThumb(saved.thumb ?? null); setAr(saved.ar || 1); setPhase('queued'); setStage(true);
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

  async function startJob(form: FormData, k: Kind, th: string | null, ratio: number) {
    lastForm.current = { form, kind: k, thumb: th, ar: ratio };
    const p = String(form.get('prompt') ?? '');
    setErr(''); setCount(0); setJob(null); setResultUrl(null); setRevealed(false); setCompare(false);
    setKind(k); setThumb(th); setAr(ratio); setStagePrompt(p); setElapsed(0); setPhase('queued'); setStage(true); setEditSource(null);
    startedRef.current = Date.now();
    try {
      const res = await fetch(API, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start generation.');
      startedRef.current = Date.now();
      const saved: Saved = { id: data.id, ts: startedRef.current, prompt: p, kind: k, thumb: th, ar: ratio };
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
  async function submitInpaint(image: Blob, mask: Blob, p: InpaintParams) {
    const form = new FormData();
    form.set('prompt', p.prompt); form.set('mode', p.mode);
    form.set('strength', String(p.strength)); form.set('grow', String(p.grow)); form.set('blend', String(p.blend));
    form.set('image', image, image.type === 'image/png' ? 'source.png' : 'source.jpg'); form.set('mask', mask, 'mask.png');
    const t = await makeThumb(image); // the clean photo: never the red mask overlay
    void startJob(form, 'edit', t?.url ?? null, t?.ar ?? 1);
  }
  async function editResult() {
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(job ?? '')}&image=0`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load that image.');
      setEditSource(await res.blob());
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load that image.'); setPhase('error'); }
  }
  function leave(clearPrompt: boolean) {
    try { localStorage.removeItem(JOB_KEY); } catch { /* ignore */ }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setStage(false); setJob(null); setResultUrl(null); setRevealed(false); setErr(''); setPhase('queued'); setFile(null);
    if (clearPrompt) setPrompt('');
  }
  function retry() {
    const l = lastForm.current;
    if (l) void startJob(l.form, l.kind, l.thumb, l.ar); else leave(false);
  }

  const showBlur = phase !== 'done' && !(phase === 'revealing' && revealed);
  const status = PHASE_LABEL[phase] ?? '';
  const dlHref = job ? `${API}?id=${encodeURIComponent(job)}&image=0` : '#';

  return <section className={`${styles.browserPane} ${styles.imagePane}`} style={{ display: visible ? undefined : 'none' }} aria-label="Image generation">
    <header className={styles.imageHeader}><span className={styles.imageTitle}>Image generation</span><button type="button" className={styles.browserPaneClose} onClick={onClose} aria-label="Close image generation"><X size={16}/></button></header>
    <div className={styles.imageContent}>
      {editSource && <InpaintEditor key={editSource.size + ':' + (editSource as File).lastModified} source={editSource} busy={false} onSubmit={(i, m, p) => void submitInpaint(i, m, p)} onCancel={() => setEditSource(null)} />}
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
        {stagePrompt && <p className={styles.rsPrompt} title={stagePrompt}>{stagePrompt}</p>}
        <div className={styles.rsActions}>
          {phase === 'error' && <><button type="button" className={styles.rsPrimary} onClick={retry}><RotateCcw size={16} aria-hidden /> Retry</button><button type="button" className={styles.rsGhost} onClick={() => leave(false)}><ArrowLeft size={16} aria-hidden /> Back to create</button></>}
          {(phase === 'done' || phase === 'revealing') && <>
            {inpaint && <button type="button" className={styles.rsPrimary} onClick={() => void editResult()}><Pencil size={16} aria-hidden /> Edit again</button>}
            <a className={styles.rsGhost} href={dlHref} download={`generated-${job?.slice(0, 8) ?? 'image'}.png`}><Download size={16} aria-hidden /> Download</a>
            {kind === 'edit' && thumb && <button type="button" className={styles.rsGhost} aria-pressed={compare}
              onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)} onPointerCancel={() => setCompare(false)}
              onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompare(true); } }} onKeyUp={() => setCompare(false)} onBlur={() => setCompare(false)}><Scaling size={16} aria-hidden /> Hold to compare</button>}
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
