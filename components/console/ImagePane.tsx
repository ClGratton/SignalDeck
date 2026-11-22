'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import styles from './assistant.module.css';

const JOB_KEY = 'grtlabs.imageJob';
const JOB_MAX_MS = 30 * 60 * 1000;

export function ImagePane({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [img2img, setImg2img] = useState(false);
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
      if (active) { setConfigured(!!d.configured); setImg2img(!!d.img2img); setUnavailable(d.reason || 'Image generation is unavailable.'); }
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
  async function generate(event: FormEvent) {
    event.preventDefault(); setError(''); setCount(0); setJob(null); setBusy(true);
    try {
      const form = new FormData(); form.set('prompt', prompt); if (file) form.set('image', file);
      const res = await fetch('/api/assistant/images', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start generation.');
      startedRef.current = Date.now();
      try { localStorage.setItem(JOB_KEY, JSON.stringify({ id: data.id, ts: startedRef.current })); } catch { /* ignore */ }
      setJob(data.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start generation.'); setBusy(false); }
  }
  return <section className={`${styles.browserPane} ${styles.imagePane}`} style={{ display: visible ? undefined : 'none' }} aria-label="Image generation">
    <header className={styles.imageHeader}><span className={styles.imageTitle}>Image generation</span><button type="button" className={styles.browserPaneClose} onClick={onClose} aria-label="Close image generation"><X size={16}/></button></header>
    <div className={styles.imageContent}>
      <form onSubmit={generate} className={styles.imageForm}>
        <label htmlFor="image-prompt">Prompt</label>
        <textarea id="image-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} placeholder="Describe the image you want to create" rows={4} />
        {img2img && <label className={styles.imageUpload}>Base image <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => setFile(e.target.files?.[0] ?? null)} />{file && <button type="button" onClick={() => { setFile(null); if (inputRef.current) inputRef.current.value = ''; }}>Remove</button>}</label>}
        <button type="submit" disabled={!configured || busy || !prompt.trim()}>{busy ? 'Generating' : 'Generate'}</button>
        {configured === false && <p role="status" className={styles.imageNote}>{unavailable}</p>}
        {error && <p role="alert" className={styles.imageError}>{error}</p>}
      </form>
      {busy && <p role="status" className={`${styles.browserLoading} ${styles.imageBusy}`}><LoaderCircle size={15} aria-hidden /> Generating your image. This may take a few minutes.</p>}
      {job && count > 0 && <div className={styles.imageResults}>{Array.from({ length: count }, (_, i) => <figure key={i}><img src={`/api/assistant/images?id=${encodeURIComponent(job)}&image=${i}`} alt={`Generated image ${i + 1}`} /><a href={`/api/assistant/images?id=${encodeURIComponent(job)}&image=${i}`} download={`generated-${i + 1}.png`}>Download</a></figure>)}</div>}
    </div>
  </section>;
}
