'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStatus } from '@/components/StatusProvider';
import styles from './SystemsPopover.module.css';

const HEALTH_WORD: Record<string, string> = {
  ok: 'up',
  degraded: 'degraded',
  down: 'offline',
};

/**
 * Per-system breakdown for the status bar. Portaled to <body> so it escapes the
 * hero's `overflow: hidden` (and the boot transform that would otherwise become
 * its containing block); positioned just above the bar's "services" trigger.
 */
export function SystemsPopover({
  id,
  anchor,
  open,
  onEnter,
  onLeave,
}: {
  id: string;
  anchor: HTMLElement | null;
  open: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { status } = useStatus();
  const systems = status.systems;
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const margin = 10;
      const pw = panelRef.current?.offsetWidth ?? 220;
      // Center on the trigger, then clamp so the panel never spills off either edge.
      const center = r.left + r.width / 2;
      const left = Math.max(margin, Math.min(center - pw / 2, window.innerWidth - pw - margin));
      setPos({ left: Math.round(left), top: Math.round(r.top) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchor]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={styles.layer}
      data-open={open}
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div id={id} ref={panelRef} role="tooltip" className={styles.panel}>
        <ul className={styles.list}>
          {systems.map((s) => (
            <li key={s.name} className={styles.row} data-health={s.health}>
              <span className={styles.dot} aria-hidden />
              <span className={styles.name}>{s.name}</span>
              <span className={`${styles.uptime} mono tnum`}>
                {s.health === 'down'
                  ? 'offline'
                  : `${HEALTH_WORD[s.health]}${s.uptimeLabel ? ` ${s.uptimeLabel}` : ''}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
