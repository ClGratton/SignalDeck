'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { useStatus } from '@/components/StatusProvider';
import { SystemsPopover } from '@/components/SystemsPopover';
import type { HealthLevel } from '@/lib/status';
import styles from './StatusPulse.module.css';

const LABEL: Record<HealthLevel, string> = {
  operational: 'All systems operational',
  partial: 'Partial outage',
  degraded: 'Degraded',
};

function StateIcon({ level }: { level: HealthLevel }) {
  if (level === 'operational') return <CheckCircle2 size={15} strokeWidth={2.2} aria-hidden />;
  if (level === 'partial') return <AlertTriangle size={15} strokeWidth={2.2} aria-hidden />;
  return <XCircle size={15} strokeWidth={2.2} aria-hidden />;
}

function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${days}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function formatChecked(secondsAgo: number): string {
  if (secondsAgo < 2) return 'checked just now';
  if (secondsAgo < 60) return `checked ${secondsAgo}s ago`;
  const m = Math.floor(secondsAgo / 60);
  return `checked ${m}m ago`;
}

export function StatusPulse() {
  const { status, stale } = useStatus();
  // Seed `now` from the status timestamp so the server and first client render
  // produce identical uptime / "checked" text — otherwise Date.now() differs
  // between the two and React throws a hydration mismatch. Go live after mount.
  const checkedAtMs = new Date(status.checkedAt).getTime();
  const [now, setNow] = useState(checkedAtMs);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Hover/focus popover listing each system + its uptime.
  const popId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hide = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 130);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const secondsAgo = Math.max(0, Math.round((now - checkedAtMs) / 1000));
  const liveUptime = status.uptimeSeconds + Math.max(0, (now - checkedAtMs) / 1000);
  const { total, affected } = status.services;

  return (
    <div className={`${styles.pulse} mono`} data-level={status.level} role="status" aria-live="polite">
      <span className={styles.indicator} aria-hidden>
        <span className={styles.dot} />
      </span>

      <span className={styles.state}>
        <StateIcon level={status.level} />
        <span>{LABEL[status.level]}</span>
      </span>

      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <button
        ref={triggerRef}
        type="button"
        className={styles.metricBtn}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        aria-label="Show systems and uptime"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        {status.level === 'operational' ? (
          <>
            <span className="tnum">{total}</span> services
          </>
        ) : (
          <>
            <span className="tnum">{affected}</span> affected
          </>
        )}
      </button>
      <SystemsPopover
        id={popId}
        anchor={triggerRef.current}
        open={open}
        onEnter={show}
        onLeave={hide}
      />

      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <Link href="/status" className={styles.uptimeLink} title="View service history">
        up <span className="tnum">{formatUptime(liveUptime)}</span>
      </Link>

      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <span className={styles.checked} data-stale={stale}>
        {stale ? (
          <>
            <RefreshCw size={12} strokeWidth={2.2} aria-hidden /> reconnecting
          </>
        ) : (
          formatChecked(secondsAgo)
        )}
      </span>
    </div>
  );
}
