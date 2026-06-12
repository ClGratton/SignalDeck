// ─────────────────────────────────────────────────────────────────────────────
// Real visitor traffic for the landing's background, pulled from Cloudflare.
//
// This runs ONLY on the server (the API token never reaches the browser). It
// returns a sanitized view of recent traffic — per-minute request counts plus the
// top hostnames and their recent rates. Counts and hostnames only: no IPs, paths,
// user agents, or anything that identifies a visitor. That shape is safe to serve
// anonymously, which is what powers the live "packets on the wires" background.
//
// The feature is OPTIONAL and degrades cleanly:
//   • CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID set  → real data, source "live".
//   • neither set, CLOUDFLARE_MOCK=1                 → sample data, source "sample"
//                                                      (dev preview of the viz).
//   • neither set, no mock                           → null; canvas stays ambient.
//
// Calls are server-side only and cached, so whether 1 or 10,000 people load the
// page, Cloudflare's API is queried at most once per cache window.
// ─────────────────────────────────────────────────────────────────────────────

import { trafficLanes } from '@/lib/config';
import { cfg } from '@/lib/service-config';

export type TrafficSource = 'live' | 'sample';

export interface SubdomainRate {
  /** Hostname, e.g. "media.grtlabs.dev". */
  host: string;
  /** Requests per minute over the recent window. */
  rate: number;
}

export interface TrafficSeries {
  /** Requests per minute, oldest → newest. Always WINDOW_MINUTES long. */
  points: number[];
  /** Sum of requests across the window. */
  total: number;
  /** Minutes covered by `points`. */
  windowMinutes: number;
  /** Top hostnames by recent volume (up to 3), highest first. Drives the packet lanes. */
  subdomains: SubdomainRate[];
  /** Whether this is live Cloudflare data or a local sample for previewing. */
  source: TrafficSource;
  /** ISO timestamp this series was computed. */
  updatedAt: string;
}

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const WINDOW_MINUTES = 30;
const RECENT_MINUTES = 5; // window used for the per-host "live rate"
const CACHE_TTL_MS = 25_000; // matches the route's s-maxage; minute-granular data caps the useful rate
const REQUEST_TIMEOUT_MS = 3_000; // never let a slow upstream stall a page render

const QUERY = `query Traffic($zone: String!, $since: Time!, $recent: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      series: httpRequestsAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $since, datetime_leq: $until }
        orderBy: [datetimeMinute_ASC]
      ) {
        count
        dimensions { datetimeMinute }
      }
      hosts: httpRequestsAdaptiveGroups(
        limit: 8
        filter: { datetime_geq: $recent, datetime_leq: $until }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientRequestHTTPHost }
      }
    }
  }
}`;

interface MinuteGroup {
  count: number;
  dimensions: { datetimeMinute: string };
}
interface HostGroup {
  count: number;
  dimensions: { clientRequestHTTPHost: string };
}

// Module-level cache. Cloudflare allows 300 GraphQL queries / 5 min; this keeps us
// far under it no matter how many visitors poll /api/traffic concurrently.
let cache: { at: number; value: TrafficSeries | null } | null = null;
let inflight: Promise<TrafficSeries | null> | null = null;

function isoMinute(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Turn the recent per-host counts into the (up to 3) wire lanes. When lanes are
// pinned in config, ALWAYS return those — in pinned order, rate 0 when the host
// has no recent Cloudflare traffic — so the indicators never disappear. Otherwise
// fall back to the three busiest hosts Cloudflare reports.
function buildLanes(hostCounts: Map<string, number>): SubdomainRate[] {
  if (trafficLanes.length > 0) {
    return trafficLanes
      .slice(0, 3)
      .map((host) => ({ host, rate: Math.round((hostCounts.get(host) ?? 0) / RECENT_MINUTES) }));
  }
  return [...hostCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([host, count]) => ({ host, rate: Math.round(count / RECENT_MINUTES) }));
}

// A believable sample for previewing the visualization without wiring Cloudflare.
function sampleSeries(): TrafficSeries {
  const now = Date.now();
  const points = Array.from({ length: WINDOW_MINUTES }, (_, i) =>
    Math.max(0, Math.round(16 + 11 * Math.sin(i / 3.5) + 6 * Math.sin(i / 1.6 + 1) + (i % 4) - 1.5)),
  );
  return {
    points,
    total: points.reduce((a, b) => a + b, 0),
    windowMinutes: WINDOW_MINUTES,
    subdomains: (trafficLanes.length > 0
      ? trafficLanes.slice(0, 3)
      : ['media.grtlabs.dev', 'home.grtlabs.dev', 'cloud.grtlabs.dev']
    ).map((host, i) => ({ host, rate: [47, 23, 9][i] ?? 5 })),
    source: 'sample',
    updatedAt: new Date(now).toISOString(),
  };
}

async function fetchSeries(token: string, zone: string): Promise<TrafficSeries | null> {
  const now = Date.now();
  const buckets = new Map<string, number>();
  const startMs = Math.floor(now / 60_000) * 60_000 - (WINDOW_MINUTES - 1) * 60_000;
  for (let i = 0; i < WINDOW_MINUTES; i++) buckets.set(isoMinute(startMs + i * 60_000), 0);

  const since = isoMinute(startMs);
  const recent = isoMinute(now - RECENT_MINUTES * 60_000);
  const until = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: QUERY, variables: { zone, since, recent, until } }),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`[cloudflare] traffic query HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      data?: { viewer?: { zones?: Array<{ series?: MinuteGroup[]; hosts?: HostGroup[] }> } };
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) {
      console.error('[cloudflare] traffic query errors:', json.errors.map((e) => e.message).join('; '));
      return null;
    }

    const zoneData = json.data?.viewer?.zones?.[0];
    for (const g of zoneData?.series ?? []) {
      const key = isoMinute(new Date(g.dimensions.datetimeMinute).getTime());
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + g.count);
    }

    const hostCounts = new Map<string, number>();
    for (const h of zoneData?.hosts ?? []) {
      const host = h.dimensions.clientRequestHTTPHost;
      if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + h.count);
    }
    const subdomains = buildLanes(hostCounts);

    const points = [...buckets.values()];
    return {
      points,
      total: points.reduce((a, b) => a + b, 0),
      windowMinutes: WINDOW_MINUTES,
      subdomains,
      source: 'live',
      updatedAt: new Date(now).toISOString(),
    };
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      console.error('[cloudflare] traffic query failed:', (err as Error)?.message ?? err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sanitized recent traffic for the landing background, cached so bursts of
 * visitors don't multiply upstream calls. Returns null when the integration is
 * off (and no sample mode) or a fetch fails — callers treat null as "off".
 */
export async function getTrafficSeries(): Promise<TrafficSeries | null> {
  const token = cfg('CLOUDFLARE_API_TOKEN');
  const zone = cfg('CLOUDFLARE_ZONE_ID');

  // No real credentials: offer the local sample if explicitly enabled, else off.
  if (!token || !zone) {
    return process.env.CLOUDFLARE_MOCK === '1' ? sampleSeries() : null;
  }

  const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
  if (fresh) return cache!.value;
  if (!inflight) {
    // Coalesce concurrent refreshes into one upstream call.
    inflight = fetchSeries(token, zone)
      .then((value) => {
        // Hold the last good series. The credentials ARE set, so a single failed
        // poll must never wipe live data back to "off" — keep the previous value
        // (and reset the TTL so we retry next window) instead of caching null.
        // Only a cold start that has never succeeded shows nothing.
        if (value != null) cache = { at: Date.now(), value };
        else if (cache) cache = { at: Date.now(), value: cache.value };
        return cache?.value ?? null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  // Stale-while-revalidate: an expired cache serves the previous series
  // immediately while the refresh runs in the background. Only the very first
  // call (empty cache) waits.
  if (cache) return cache.value;
  return inflight;
}

/**
 * Never-blocking variant for the root layout: returns whatever is cached right
 * now (null on a cold start — the canvas stays ambient) and triggers a
 * background refresh when stale. The client polls /api/traffic, so live data
 * follows within its poll window.
 */
export function peekTrafficSeries(): TrafficSeries | null {
  const token = cfg('CLOUDFLARE_API_TOKEN');
  const zone = cfg('CLOUDFLARE_ZONE_ID');
  if (!token || !zone) {
    return process.env.CLOUDFLARE_MOCK === '1' ? sampleSeries() : null;
  }
  if (!cache || Date.now() - cache.at >= CACHE_TTL_MS) void getTrafficSeries();
  return cache?.value ?? null;
}
