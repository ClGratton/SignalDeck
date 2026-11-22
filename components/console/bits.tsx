'use client';

// Small shared console primitives: panel frame, capacity meter, status dot,
// uptime formatting, skeleton rows. Status is ALWAYS color + text, never color
// alone.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ConsoleSnapshot } from '@/lib/console';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import styles from './console.module.css';

// Shared data for the data-driven widgets (the snapshot + first-load flag), plus
// the connection state the tile chrome needs (stale marker, Retry).
export interface DashboardData {
  snapshot: ConsoleSnapshot | null;
  loading: boolean;
  stale?: boolean;
  lastOk?: number | null;
  retry?: () => void | Promise<void>;
}
const DataCtx = createContext<DashboardData>({ snapshot: null, loading: true });
export function DashboardDataProvider({ value, children }: { value: DashboardData; children: ReactNode }) {
  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}
export const useDashboardData = () => useContext(DataCtx);

/** One decimal at most, trailing zero trimmed (D5). */
export const fmtNum = (n: number): string => String(Math.round(n * 10) / 10);

/** Brief highlight when a live number changes, so updates are noticed (MI5). */
function useFlash(value: unknown) {
  const first = useRef(true);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 600);
    return () => window.clearTimeout(t);
  }, [value]);
  return flash;
}

export function Panel({
  title,
  meta,
  children,
  area,
  Icon,
  tone,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  /** grid-area name on desktop */
  area: string;
  Icon?: LucideIcon;
  /** Backend health for the header dot; the word is always printed too. */
  tone?: 'ok' | 'warn' | 'down';
}) {
  const { stale } = useDashboardData();
  const shown = stale && tone === 'ok' ? 'warn' : tone;
  const word = stale && tone === 'ok' ? 'stale' : tone === 'down' ? 'offline' : tone === 'warn' ? 'degraded' : 'live';
  return (
    <section className={styles.panel} style={{ gridArea: area }} aria-label={title}>
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>
          {Icon ? <Icon size={15} strokeWidth={2.2} aria-hidden className={styles.panelIcon} /> : null}
          {title}
        </h2>
        {shown ? (
          <span className={`${styles.panelState} mono`} data-tone={shown}>
            <span className={styles.statusDot} aria-hidden />
            {word}
          </span>
        ) : null}
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
  hotAt = 0.9,
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
  const flash = useFlash(fmtNum(used));
  return (
    <div className={styles.meter}>
      <span className={`${styles.meterLabel} mono`}>{label}</span>
      <span
        className={styles.meterTrack}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={Math.min(total, used)}
        aria-valuetext={`${fmtNum(used)} of ${fmtNum(total)} ${unit}, ${tone === 'ok' ? 'normal' : tone === 'warn' ? 'high' : 'critical'}`}
      >
        <span className={styles.meterFill} data-tone={tone} style={{ width: `${frac * 100}%` }} />
      </span>
      <span className={`${styles.meterValue} mono tnum`} data-flash={flash || undefined}>
        {fmtNum(used)}
        <span className={styles.meterOf}>/{fmtNum(total)}</span> {unit}
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
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height="0.85rem" width={`${88 - i * 14}%`} />
      ))}
    </div>
  );
}

/** A backend that didn't answer: plain words, the last-update context and a Retry (D4/ES1). */
export function Unreachable({ name }: { name: string }) {
  const { retry, lastOk } = useDashboardData();
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.unreachable} role="status">
      <p>
        {name} did not answer the last probe.
        {lastOk && Date.now() - lastOk >= 60_000
          ? ` Last successful update ${Math.round((Date.now() - lastOk) / 60000)}m ago.`
          : ''}
      </p>
      {retry ? (
        <Button
          variant="secondary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await retry();
            } finally {
              setBusy(false);
            }
          }}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
