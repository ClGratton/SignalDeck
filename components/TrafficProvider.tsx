'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { TrafficSeries } from '@/lib/cloudflare';

interface TrafficContextValue {
  /** Null when the Cloudflare integration is off or the last poll failed. */
  traffic: TrafficSeries | null;
}

const TrafficContext = createContext<TrafficContextValue>({ traffic: null });

// Cloudflare buckets by the minute, so ~30s catches each new minute promptly
// without re-fetching the same bucket; faster than this just burns quota.
const POLL_SECONDS = 30;

export function TrafficProvider({
  initial,
  children,
}: {
  initial: TrafficSeries | null;
  children: React.ReactNode;
}) {
  const [traffic, setTraffic] = useState<TrafficSeries | null>(initial);

  useEffect(() => {
    let active = true;
    let id: number | undefined;

    const tick = async () => {
      try {
        // Lets the shared CDN/browser cache satisfy the request when warm; the
        // route sets s-maxage so this is absorbed at the edge under real load.
        const res = await fetch('/api/traffic');
        if (!res.ok) return;
        const data = (await res.json()) as { enabled: boolean; series: TrafficSeries | null };
        if (active) setTraffic(data.series);
      } catch {
        // Keep the last known-good series; the canvas tweens, so a missed poll is invisible.
      }
    };

    // Only poll while the tab is visible — no useless background polling when the
    // page is buried in another tab. Resume (and refresh once) when it returns.
    const start = () => {
      if (id != null) return;
      id = window.setInterval(tick, POLL_SECONDS * 1000);
    };
    const stop = () => {
      if (id != null) window.clearInterval(id);
      id = undefined;
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        tick();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      active = false;
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <TrafficContext.Provider value={{ traffic }}>{children}</TrafficContext.Provider>;
}

export function useTraffic() {
  return useContext(TrafficContext);
}
