'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ImagePlus, LoaderCircle, Pencil, X } from 'lucide-react';
import styles from './assistant.module.css';
import { InpaintEditor, type InpaintParams } from './InpaintEditor';

const JOB_KEY = 'grtlabs.imageJob';
const JOB_MAX_MS = 30 * 60 * 1000;

export function ImagePane({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [img2img, setImg2img] = useState(false);
  const [inpaint, setInpaint] = useState(false);
  const [editSource, setEditSource] = useState<Blob | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const [unavailable, setUnavailable] = useState('Image generation is not configured yet.');
  const [prompt, setPrompt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const startedRef = useRef(0);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const check = () => { void fetch('/api/assistant/images', { cache: 'no-store' }).then(r => r.json()).then(d => {
      if (active) { setConfigured(!!d.configured); setImg2img(!!d.img2img); setInpaint(!!d.inpaint); setUnavailable(d.reason || 'Image generation is unavailable.'); }
    }).catch(() => { if (active) { setConfigured(false); setUnavailable('Image service is unavailable.'); } }); };
    check();
    const timer = window.setInterval(check, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [visible]);
  // Resume a job that was started before a reload / pane remount.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(JOB_KEY) || 'null');
      if (saved?.id && Date.now() - saved.ts < JOB_MAX_MS) { setJob(saved.id); setBusy(true); startedRef.current = saved.ts; }
      else localStorage.removeItem(JOB_KEY);
    } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    if (!job || !busy) return;
    let active = true;
    let failures = 0;
    const finish = () => { try { localStorage.removeItem(JOB_KEY); } catch { /* ignore */ } };
    const poll = async () => {
      try {
        const res = await fetch(`/api/assistant/images?id=${encodeURIComponent(job)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!active) return;
        // 5xx / network errors are transient (the image host can stall for minutes while it loads the model):
        // keep polling until the job's overall deadline instead of abandoning a job that is still running.
        if (res.status >= 500 || (res.status === 502)) throw new Error('transient');
        if (!res.ok || data.status === 'error') { setError(data.error || 'Generation failed.'); setBusy(false); finish(); }
        else if (data.status === 'complete') { setCount(data.count); setBusy(false); finish(); }
        else failures = 0;
      } catch {
        if (!active) return;
        failures++;
        if (Date.now() - startedRef.current > JOB_MAX_MS) { setError('Image generation timed out. Please try again.'); setBusy(false); finish(); }
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [job, busy]);
  async function startJob(form: FormData) {
    setError(''); setCount(0); setJob(null); setBusy(true);
    try {
      const res = await fetch('/api/assistant/images', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start generation.');
      startedRef.current = Date.now();
      try { localStorage.setItem(JOB_KEY, JSON.stringify({ id: data.id, ts: startedRef.current })); } catch { /* ignore */ }
      setJob(data.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start generation.'); setBusy(false); }
  }
  function generate(event: FormEvent) {
    event.preventDefault();
    const form = new FormData(); form.set('prompt', prompt); if (file) form.set('image', file);
    void startJob(form);
  }
  function submitInpaint(image: Blob, mask: Blob, p: InpaintParams) {
    const form = new FormData();
    form.set('prompt', p.prompt); form.set('mode', p.mode);
    form.set('strength', String(p.strength)); form.set('grow', String(p.grow)); form.set('blend', String(p.blend));
    form.set('image', image, image.type === 'image/png' ? 'source.png' : 'source.jpg'); form.set('mask', mask, 'mask.png');
    void startJob(form);
  }
  async function editResult(index: number) {
    try {
      const res = await fetch(`/api/assistant/images?id=${encodeURIComponent(job ?? '')}&image=${index}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load that image.');
      setEditSource(await res.blob());
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load that image.'); }
  }
  return <section className={`${styles.browserPane} ${styles.imagePane}`} style={{ display: visible ? undefined : 'none' }} aria-label="Image generation">
    <header className={styles.imageHeader}><span className={styles.imageTitle}>Image generation</span><button type="button" className={styles.browserPaneClose} onClick={onClose} aria-label="Close image generation"><X size={16}/></button></header>
    <div className={styles.imageContent}>
      {editSource && <InpaintEditor key={editSource.size + ':' + (editSource as File).lastModified} source={editSource} busy={busy} onSubmit={submitInpaint} onCancel={() => setEditSource(null)} />}
      {editSource ? null : <form onSubmit={generate} className={styles.imageForm}>
        <label htmlFor="image-prompt">Prompt</label>
        <textarea id="image-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} placeholder="Describe the image you want to create" rows={4} />
        <div className={styles.imageRow}>
          <button type="submit" disabled={!configured || busy || !prompt.trim() || (!!file && !inpaint)}>{busy ? 'Generating' : 'Generate'}</button>
          {inpaint
            ? <label className={styles.imagePick}><ImagePlus size={16} aria-hidden /> Upload to edit<input ref={editInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const f = e.target.files?.[0]; if (f) setEditSource(f); e.target.value = ''; }} /></label>
            : img2img && <label className={styles.imagePick}><ImagePlus size={16} aria-hidden /> {file ? file.name : 'Base image'}<input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>}
        </div>
        {configured === false && <p role="status" className={styles.imageNote}>{unavailable}</p>}
      </form>}
      {error && <p role="alert" className={styles.imageError}>{error}</p>}
      {busy && <p role="status" className={`${styles.browserLoading} ${styles.imageBusy}`}><LoaderCircle size={15} aria-hidden /> Generating your image. This may take a few minutes.</p>}
      {job && count > 0 && <div className={styles.imageResults}>{Array.from({ length: count }, (_, i) => <figure key={i}><img src={`/api/assistant/images?id=${encodeURIComponent(job)}&image=${i}`} alt={`Generated image ${i + 1}`} />{inpaint && !busy && <button type="button" className={styles.imageEdit} onClick={() => void editResult(i)}><Pencil size={14} aria-hidden /> Edit</button>}<a href={`/api/assistant/images?id=${encodeURIComponent(job)}&image=${i}`} download={`generated-${i + 1}.png`}>Download</a></figure>)}</div>}
    </div>
  </section>;
}
