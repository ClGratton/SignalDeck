'use client';

import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  LoaderCircle,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import type { AssistantEvent, BrowserViewportDto } from '@/lib/assistant/types';
import styles from './assistant.module.css';

type BrowserFrame = Extract<AssistantEvent, { type: 'browser' }>;
type FramePayload = Omit<BrowserFrame, 'type'> & { error?: string };

interface BrowserPaneProps {
  frame: BrowserFrame | null;
  onFrame: (frame: BrowserFrame) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}

function paneViewport(element: HTMLDivElement | null): BrowserViewportDto {
  if (!element) return { width: 1280, height: 720 };
  return {
    width: Math.max(480, Math.round(element.clientWidth)),
    height: Math.max(320, Math.round(element.clientHeight)),
  };
}

export function BrowserPane({ frame, onFrame, onClose, anchorRef }: BrowserPaneProps) {
  const [address, setAddress] = useState(frame?.url ?? '');
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pulse, setPulse] = useState<{ x: number; y: number; id: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportSize = useRef<BrowserViewportDto>({ width: 1280, height: 720 });
  const typed = useRef('');
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheel = useRef({ x: 0, y: 0, clientX: 0, clientY: 0 });
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  const frameRef = useRef(frame);
  const postRef = useRef<((body: Record<string, unknown>, refresh?: boolean) => Promise<void>) | null>(null);
  const [paneFrame, setPaneFrame] = useState<CSSProperties | undefined>();

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const measure = () => {
      if (window.innerWidth <= 1100) {
        setPaneFrame(undefined);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const next = {
        top: rect.top,
        bottom: Math.max(0, window.innerHeight - rect.bottom),
      } satisfies CSSProperties;
      setPaneFrame((current) => (
        current?.top === next.top && current?.bottom === next.bottom ? current : next
      ));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    frameRef.current = frame;
    if (frame?.url) setAddress(frame.url);
  }, [frame]);

  const applyPayload = useCallback((data: FramePayload, seq: number) => {
    if (seq < appliedSeq.current) return;
    appliedSeq.current = seq;
    onFrame({
      type: 'browser',
      imageUrl: data.imageUrl,
      url: data.url,
      title: data.title,
      tabId: data.tabId,
      tabs: data.tabs,
      viewport: data.viewport,
      latencyMs: data.latencyMs,
    });
  }, [onFrame]);

  const snapshot = useCallback(async (tabId?: string, quiet = false) => {
    const seq = ++requestSeq.current;
    if (!quiet) setPending((count) => count + 1);
    try {
      const size = viewportSize.current;
      const params = new URLSearchParams({ width: String(size.width), height: String(size.height) });
      if (tabId) params.set('tabId', tabId);
      const res = await fetch(`/api/assistant/browser?${params}`, { cache: 'no-store' });
      const data = (await res.json()) as FramePayload;
      if (!res.ok) throw new Error(data.error || `Browser request failed (${res.status}).`);
      applyPayload(data, seq);
    } catch (err) {
      if (!quiet) setError(err instanceof Error ? err.message : 'Browser unavailable.');
    } finally {
      if (!quiet) setPending((count) => Math.max(0, count - 1));
    }
  }, [applyPayload]);

  const scheduleRefresh = useCallback((tabId?: string) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void snapshot(tabId, true), 700);
  }, [snapshot]);

  const post = useCallback(async (body: Record<string, unknown>, refresh = true) => {
    const seq = ++requestSeq.current;
    setPending((count) => count + 1);
    setError(null);
    try {
      const payload = {
        ...body,
        ...(!('tabId' in body) && frame?.tabId ? { tabId: frame.tabId } : {}),
        viewport: viewportSize.current,
      };
      const res = await fetch('/api/assistant/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as FramePayload;
      if (!res.ok) throw new Error(data.error || `Browser request failed (${res.status}).`);
      applyPayload(data, seq);
      if (refresh) scheduleRefresh(data.tabId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Browser action failed.');
    } finally {
      setPending((count) => Math.max(0, count - 1));
    }
  }, [applyPayload, frame?.tabId, scheduleRefresh]);
  postRef.current = post;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    viewportSize.current = paneViewport(element);
    const observer = new ResizeObserver(() => {
      viewportSize.current = paneViewport(element);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        const tabId = frameRef.current?.tabId;
        if (tabId) void postRef.current?.({ command: 'resize', tabId }, false);
      }, 180);
    });
    observer.observe(element);
    if (!frameRef.current) void snapshot();
    return () => observer.disconnect();
  }, [snapshot]);

  useEffect(() => () => {
    if (typeTimer.current) clearTimeout(typeTimer.current);
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
  }, []);

  const flushTyped = useCallback(() => {
    const text = typed.current;
    typed.current = '';
    if (typeTimer.current) clearTimeout(typeTimer.current);
    typeTimer.current = null;
    if (text) void post({ actions: [{ type: 'type', text }] });
  }, [post]);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      document.querySelector<HTMLInputElement>(`.${styles.browserAddress}`)?.focus();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') {
      event.preventDefault();
      void post({ command: 'new_tab' }, false);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w' && frame?.tabId) {
      event.preventDefault();
      void post({ command: 'close_tab', tabId: frame.tabId }, false);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      typed.current += event.key;
      if (typeTimer.current) clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(flushTyped, 90);
      return;
    }
    flushTyped();
    const names: string[] = [];
    if (event.ctrlKey) names.push('CTRL');
    if (event.metaKey) names.push('META');
    if (event.altKey) names.push('ALT');
    if (event.shiftKey) names.push('SHIFT');
    names.push(event.key === ' ' ? 'SPACE' : event.key.toUpperCase());
    if (!['SHIFT', 'CONTROL', 'ALT', 'META'].includes(event.key.toUpperCase())) {
      event.preventDefault();
      void post({ actions: [{ type: 'keypress', keys: names }] });
    }
  };

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const remote = frame?.viewport ?? { width: 1280, height: 720 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * remote.width,
      y: ((event.clientY - rect.top) / rect.height) * remote.height,
      localX: event.clientX - rect.left,
      localY: event.clientY - rect.top,
    };
  };

  return (
    <section className={styles.browserPane} style={paneFrame} aria-label="Visual browser">
      <header className={styles.browserTabs}>
        <div className={styles.browserTabList} role="tablist" aria-label="Browser tabs">
          {(frame?.tabs ?? []).map((tab) => (
            <div
              key={tab.id}
              className={styles.browserTab}
              data-active={tab.id === frame?.tabId || undefined}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === frame?.tabId}
                className={styles.browserTabSelect}
                onClick={() => void post({ command: 'activate_tab', tabId: tab.id }, false)}
                title={tab.title || tab.url}
              >
                <Globe2 size={12} aria-hidden />
                <span>{tab.title || 'New tab'}</span>
              </button>
              <button
                type="button"
                className={styles.browserTabClose}
                onClick={() => void post({ command: 'close_tab', tabId: tab.id }, false)}
                aria-label={`Close ${tab.title || 'tab'}`}
              >
                <X size={11} aria-hidden />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.browserNewTab}
            onClick={() => void post({ command: 'new_tab' }, false)}
            aria-label="New browser tab"
            title="New tab"
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>
        <button type="button" className={styles.browserPaneClose} onClick={onClose} aria-label="Close browser pane">
          <X size={15} aria-hidden />
        </button>
      </header>

      <form
        className={styles.browserBar}
        onSubmit={(event) => {
          event.preventDefault();
          if (address.trim()) void post({ navigate: address });
        }}
      >
        <div className={styles.browserNav}>
          <button type="button" onClick={() => void post({ command: 'back' })} aria-label="Back">
            <ArrowLeft size={14} aria-hidden />
          </button>
          <button type="button" onClick={() => void post({ command: 'forward' })} aria-label="Forward">
            <ArrowRight size={14} aria-hidden />
          </button>
          <button type="button" onClick={() => void post({ command: 'reload' })} aria-label="Reload">
            <RefreshCw size={13} aria-hidden />
          </button>
        </div>
        <input
          className={styles.browserAddress}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="Browser address"
          spellCheck={false}
        />
        <button type="submit" className={styles.browserGo} disabled={!address.trim()} aria-label="Open address">
          <ArrowRight size={14} aria-hidden />
        </button>
        <span className={styles.browserActivity} aria-live="polite">
          {pending > 0 ? <><LoaderCircle size={12} aria-hidden /> Syncing</> : frame?.latencyMs ? `${frame.latencyMs} ms` : 'Ready'}
        </span>
      </form>

      {error ? <p className={styles.browserError} role="alert">{error}</p> : null}
      <div
        ref={viewportRef}
        className={styles.browserViewport}
        tabIndex={0}
        onKeyDown={keyDown}
        onPointerDown={(event) => {
          if (!frame || event.button !== 0) return;
          event.currentTarget.focus();
          const p = point(event);
          setPulse({ x: p.localX, y: p.localY, id: Date.now() });
          void post({ actions: [{ type: 'click', x: p.x, y: p.y, button: 'left' }] });
        }}
        onContextMenu={(event) => {
          if (!frame) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const remote = frame.viewport;
          void post({ actions: [{
            type: 'click',
            x: ((event.clientX - rect.left) / rect.width) * remote.width,
            y: ((event.clientY - rect.top) / rect.height) * remote.height,
            button: 'right',
          }] });
        }}
        onWheel={(event) => {
          if (!frame) return;
          event.preventDefault();
          wheel.current.x += event.deltaX;
          wheel.current.y += event.deltaY;
          wheel.current.clientX = event.clientX;
          wheel.current.clientY = event.clientY;
          if (wheelTimer.current) clearTimeout(wheelTimer.current);
          wheelTimer.current = setTimeout(() => {
            const rect = viewportRef.current?.getBoundingClientRect();
            const remote = frame.viewport;
            const current = wheel.current;
            wheel.current = { x: 0, y: 0, clientX: 0, clientY: 0 };
            if (!rect) return;
            void post({ actions: [{
              type: 'scroll',
              x: ((current.clientX - rect.left) / rect.width) * remote.width,
              y: ((current.clientY - rect.top) / rect.height) * remote.height,
              scroll_x: current.x,
              scroll_y: current.y,
            }] });
          }, 80);
        }}
        aria-label="Interactive browser page. Click, scroll, and type directly."
      >
        {frame ? (
          <img
            className={styles.browserScreen}
            src={frame.imageUrl}
            alt={frame.title ? `Browser page: ${frame.title}` : 'Current browser page'}
            draggable={false}
            decoding="async"
          />
        ) : (
          <div className={styles.browserLoading}><LoaderCircle size={15} aria-hidden /> Starting browser</div>
        )}
        {pulse ? (
          <span
            key={pulse.id}
            className={styles.browserClickPulse}
            style={{ left: pulse.x, top: pulse.y }}
            aria-hidden
          />
        ) : null}
      </div>
      <p className={styles.browserHint}>
        Direct control · <kbd>Ctrl L</kbd> address · <kbd>Ctrl T</kbd> new tab · sessions remain server-side
      </p>
    </section>
  );
}
