'use client';

import { useEffect, useRef, useState } from 'react';
import { CANVAS_BLUR_STORAGE_KEY } from '@/lib/theme';

// Temporary on-device diagnostics. Active ONLY in development with ?debug=1, so it
// never appears in normal use. Defaults to a small chip in the bottom-left corner
// (clear of the header/theme toggle); tap it to expand a blurred, readable panel.
// Reads the live DOM/canvas directly — no instrumentation of other components.
export function DebugPanel() {
  const [on, setOn] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [taps, setTaps] = useState(0);
  const errsRef = useRef<string[]>([]);
  const lastSig = useRef<number | null>(null);

  // Live-tunable blur on the background telemetry canvas (the sines), seeded from
  // localStorage so the slider reflects whatever the pre-paint script already set.
  const [blur, setBlur] = useState(() => {
    if (typeof window === 'undefined') return 0;
    try {
      return parseInt(localStorage.getItem(CANVAS_BLUR_STORAGE_KEY) || '0', 10) || 0;
    } catch {
      return 0;
    }
  });

  useEffect(() => {
    if (!on) return;
    document.documentElement.style.setProperty('--canvas-blur', `${blur}px`);
  }, [blur, on]);

  const changeBlur = (v: number) => {
    setBlur(v);
    try {
      localStorage.setItem(CANVAS_BLUR_STORAGE_KEY, `${v}px`);
    } catch {
      /* storage unavailable; the live value still applies for the session */
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (process.env.NODE_ENV !== 'development') return; // dev-only diagnostic
    if (new URLSearchParams(window.location.search).get('debug') !== '1') return;
    setOn(true);

    const onErr = (e: ErrorEvent) =>
      errsRef.current.unshift('ERR ' + (e.message || String(e.error)).slice(0, 80));
    const onRej = (e: PromiseRejectionEvent) =>
      errsRef.current.unshift('REJ ' + String(e.reason).slice(0, 80));
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);

    const tick = () => {
      const out: string[] = [];
      out.push(navigator.userAgent.slice(0, 64));
      const vv = window.visualViewport;
      out.push(
        `inner ${window.innerWidth}x${window.innerHeight} · dpr ${window.devicePixelRatio} · vv ${
          vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) : 'n/a'
        }`,
      );
      out.push(
        `reduceMotion=${window.matchMedia('(prefers-reduced-motion: reduce)').matches} · theme=${
          document.documentElement.dataset.theme
        }`,
      );

      const c = document.querySelector('canvas');
      if (!c) {
        out.push('canvas: NOT FOUND');
      } else {
        const r = c.getBoundingClientRect();
        out.push(`canvas rect ${Math.round(r.width)}x${Math.round(r.height)} · backing ${c.width}x${c.height}`);
        try {
          const ctx = c.getContext('2d');
          if (ctx && c.width > 0 && c.height > 0) {
            const y0 = Math.floor(c.height * 0.45);
            const h = Math.max(1, Math.floor(c.height * 0.2));
            const d = ctx.getImageData(0, y0, c.width, h).data;
            let sum = 0;
            let nz = 0;
            for (let i = 3; i < d.length; i += 401) {
              sum += d[i];
              if (d[i] > 0) nz++;
            }
            const animating = lastSig.current !== null && lastSig.current !== sum;
            lastSig.current = sum;
            out.push(`content nz=${nz} sum=${sum} animating=${animating}`);
          } else {
            out.push('content: canvas has 0 size');
          }
        } catch (err) {
          out.push('content: getImageData threw ' + (err as Error).message);
        }
      }

      out.push('errors: ' + (errsRef.current.slice(0, 3).join(' | ') || 'none'));
      setLines(out);
    };

    tick();
    const id = window.setInterval(tick, 600);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, []);

  if (!on) return null;

  const glass: React.CSSProperties = {
    background: 'rgba(12,14,18,0.66)',
    WebkitBackdropFilter: 'blur(10px)',
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(255,255,255,0.16)',
    color: '#c9f5d3',
    font: '11px/1.55 ui-monospace, monospace',
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: 12,
        bottom: 12,
        zIndex: 2147483647,
        display: 'flex',
        flexDirection: 'column-reverse', // chip at bottom, panel grows upward
        alignItems: 'flex-start',
        gap: 8,
        maxWidth: 'min(92vw, 460px)',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        style={{
          ...glass,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 999,
          cursor: 'pointer',
          fontWeight: 700,
          color: '#fff',
        }}
      >
        <span aria-hidden style={{ color: '#8dff8d' }}>
          ●
        </span>
        debug {expanded ? '▾' : '▸'}
      </button>

      {expanded && (
        <div
          style={{
            ...glass,
            borderRadius: 12,
            padding: '10px 12px',
            maxHeight: '60vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          }}
        >
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}

          <label
            htmlFor="dbg-blur"
            style={{
              marginTop: 8,
              paddingTop: 8,
              borderTop: '1px solid rgba(255,255,255,0.14)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>bg blur</span>
            <input
              id="dbg-blur"
              type="range"
              min={0}
              max={24}
              step={1}
              value={blur}
              onChange={(e) => changeBlur(Number(e.target.value))}
              style={{ flex: 1, accentColor: '#8dff8d' }}
            />
            <span style={{ minWidth: 36, textAlign: 'right' }} className="tnum">
              {blur}px
            </span>
          </label>

          <button
            type="button"
            onClick={() => setTaps((t) => t + 1)}
            style={{
              marginTop: 8,
              background: 'rgba(255,255,255,0.08)',
              color: '#c9f5d3',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 8,
              padding: '6px 12px',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            tap test: {taps}
          </button>
        </div>
      )}
    </div>
  );
}
