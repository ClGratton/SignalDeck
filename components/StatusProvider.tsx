'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { AggregateStatus } from '@/lib/status';

interface StatusContextValue {
  status: AggregateStatus;
  /** True when the last poll failed; the pulse surfaces this as "reconnecting". */
  stale: boolean;
}

const StatusContext = createContext<StatusContextValue | null>(null);

const POLL_SECONDS = Math.max(5, Number(process.env.NEXT_PUBLIC_STATUS_POLL_SECONDS ?? 20));

export function StatusProvider({
  initial,
  children,
}: {
  initial: AggregateStatus;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<AggregateStatus>(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        // No `no-store`: let the shared CDN/browser cache satisfy this so visitor
        // polling is absorbed at the edge (the route sets a short s-maxage).
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as AggregateStatus;
        if (!active) return;
        setStatus(data);
        setStale(false);
      } catch {
        // Keep the last known-good reading; mark it stale so the pulse can say so.
        if (active) setStale(true);
      }
    };

    const id = window.setInterval(tick, POLL_SECONDS * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      active = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <StatusContext.Provider value={{ status, stale }}>{children}</StatusContext.Provider>;
}

export function useStatus() {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error('useStatus must be used within StatusProvider');
  return ctx;
}
