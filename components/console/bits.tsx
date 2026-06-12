'use client';

// Small shared console primitives: panel frame, capacity meter, status dot,
// uptime formatting, skeleton rows. Status is ALWAYS color + text, never color
// alone.

import type { ReactNode } from 'react';
import styles from './console.module.css';

export function Panel({
  title,
  meta,
  children,
  area,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  /** grid-area name on desktop */
  area: string;
}) {
  return (
    <section className={styles.panel} style={{ gridArea: area }}>
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>{title}</h2>
        {meta != null ? <span className={`${styles.panelMeta} mono`}>{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** Thin capacity bar with the value printed beside it. `warnAt`/`hotAt` are
 *  fractions of capacity that recolor the fill (e.g. storage 0.8 / 0.92). */
export function Meter({
  label,
  used,
  total,
  unit,
  warnAt = 0.8,
  hotAt = 0.92,
}: {
  label: string;
  used: number;
  total: number;
  unit: string;
  warnAt?: number;
  hotAt?: number;
}) {
  const frac = total > 0 ? Math.min(1, used / total) : 0;
  const tone = frac >= hotAt ? 'down' : frac >= warnAt ? 'warn' : 'ok';
  return (
    <div className={styles.meter}>
      <span className={`${styles.meterLabel} mono`}>{label}</span>
      <span className={styles.meterTrack} role="presentation">
        <span className={styles.meterFill} data-tone={tone} style={{ width: `${frac * 100}%` }} />
      </span>
      <span className={`${styles.meterValue} mono tnum`}>
        {used}
        <span className={styles.meterOf}>/{total}</span> {unit}
      </span>
    </div>
  );
}

export function StatusDot({ tone, label }: { tone: 'ok' | 'warn' | 'down' | 'off'; label: string }) {
  return (
    <span className={styles.status} data-tone={tone}>
      <span className={styles.statusDot} aria-hidden />
      {label}
    </span>
  );
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(seconds / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

/** Loading placeholder while the first snapshot is in flight. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className={styles.skeleton} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={styles.skeletonRow} style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  );
}

/** A backend that didn't answer. Plain words, no mystery. */
export function Unreachable({ name }: { name: string }) {
  return (
    <p className={styles.unreachable}>
      <StatusDot tone="down" label="unreachable" /> {name} did not answer the last probe.
    </p>
  );
}
