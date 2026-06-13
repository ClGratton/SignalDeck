// ─────────────────────────────────────────────────────────────────────────────
// Sanitized real homelab telemetry for the public landing.
//
// Runs ONLY on the server (tokens never reach the browser). Fans out to Proxmox
// (load, cores, memory, VM/CT counts, uptime), TrueNAS (storage), and lightweight
// health pings (Jellyfin, Home Assistant), then returns AGGREGATE, non-identifying
// numbers — counts, totals, a health level, an uptime. No hostnames, IPs, VM
// names, or contents. That shape is safe to serve anonymously.
//
// Cached + in-flight-coalesced like lib/cloudflare.ts, so whether 1 or 10,000
// people load the page, each backend is probed at most once per cache window.
// Everything degrades to null on failure; callers fall back to static defaults.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import https from 'node:https';
import { cfg } from '@/lib/service-config';
import { openLabSocket, type LabSocket } from '@/lib/ws-rpc';
import type { HealthLevel } from '@/lib/status';
import type { SystemHealth } from '@/lib/config';
import { recordSystems } from '@/lib/history-store';

export interface SystemStat {
  name: string;
  health: SystemHealth;
  /** Seconds of uptime where the backend reports it, else null. */
  uptimeSeconds: number | null;
}

export interface HomelabSummary {
  /** Aggregate compute load 0–100 (core-weighted CPU across Proxmox nodes). */
  load: number;
  cores: number;
  memUsedGB: number;
  memTotalGB: number;
  /** From TrueNAS; null when unavailable (caller keeps its placeholder). */
  storageUsedTB: number | null;
  storageTotalTB: number | null;
  vms: number;
  containers: number;
  /** Longest node uptime, the lab's effective "up since". */
  uptimeSeconds: number;
  /** Service total / healthy / affected, for the aggregate pulse. */
  services: { total: number; healthy: number; affected: number };
  level: HealthLevel;
  /** Per-system health for the status popover. */
  systems: SystemStat[];
}

const CACHE_TTL_MS = 15_000;
const TIMEOUT_MS = 3_500;

/** Per-call backend timeout, owner-tunable via Settings (ASSISTANT_REQUEST_TIMEOUT,
 *  in seconds). Clamped to a sane band so a dead service errors out instead of
 *  stalling a turn, and a typo can't hang it forever. Default 3.5s. */
function requestTimeoutMs(): number {
  const s = Number(cfg('ASSISTANT_REQUEST_TIMEOUT'));
  if (!Number.isFinite(s) || s <= 0) return TIMEOUT_MS;
  return Math.min(Math.max(s * 1000, 1000), 120_000);
}

export interface JsonResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface FetchOpts {
  headers?: Record<string, string>;
  /** false skips TLS verification (self-signed labs); default true. */
  verifyTls?: boolean;
  /** HTTP method; GET unless an action explicitly needs to mutate. */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** JSON body for write actions. */
  body?: unknown;
  /** Form-encode the body instead of JSON (Proxmox write APIs expect this). */
  form?: boolean;
}

// Plain node http/https so we can control TLS verification per host (Node fetch
// can't skip it per request) and so the bundler doesn't need undici. Returns null
// on any network/TLS/timeout error; never throws. Shared with lib/console.ts.
export function labFetch(rawUrl: string, opts: FetchOpts = {}): Promise<JsonResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: JsonResult | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return done(null);
    }
    const mod = url.protocol === 'http:' ? http : https;
    // Proxmox write endpoints want application/x-www-form-urlencoded; most other
    // backends want JSON. `form` selects the encoding for the body.
    let payload: string | null = null;
    let contentType: string | null = null;
    if (opts.body != null) {
      if (opts.form && typeof opts.body === 'object') {
        payload = new URLSearchParams(
          Object.fromEntries(
            Object.entries(opts.body as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          ),
        ).toString();
        contentType = 'application/x-www-form-urlencoded';
      } else {
        payload = JSON.stringify(opts.body);
        contentType = 'application/json';
      }
    }
    const req = mod.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(contentType != null ? { 'Content-Type': contentType } : {}),
          ...opts.headers,
        },
        rejectUnauthorized: opts.verifyTls !== false,
        timeout: requestTimeoutMs(),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf8');
          let data: unknown = null;
          try {
            data = body ? JSON.parse(body) : null;
          } catch {
            /* non-JSON body — leave data null */
          }
          done({ ok: status >= 200 && status < 300, status, data });
        });
      },
    );
    req.on('error', () => done(null));
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    if (payload != null) req.write(payload);
    req.end();
  });
}

export const envBool = (v: string | undefined, dflt = true) =>
  v == null ? dflt : !/^(false|0|no)$/i.test(v.trim());

export const trimSlash = (s: string) => s.replace(/\/+$/, '');

// ── Proxmox ──────────────────────────────────────────────────────────────────
interface PveResource {
  type: string;
  status?: string;
  maxcpu?: number;
  cpu?: number;
  maxmem?: number;
  mem?: number;
  uptime?: number;
}

interface ProxmoxStats {
  load: number;
  cores: number;
  memUsedGB: number;
  memTotalGB: number;
  vms: number;
  containers: number;
  uptimeSeconds: number;
  nodesOnline: number;
  nodesTotal: number;
}

async function probeProxmox(): Promise<ProxmoxStats | null> {
  const host = cfg('PROXMOX_HOST');
  const tokenId = cfg('PROXMOX_TOKEN_ID');
  const secret = cfg('PROXMOX_TOKEN_SECRET');
  if (!host || !tokenId || !secret) return null;

  const res = await labFetch(`${trimSlash(host)}/api2/json/cluster/resources`, {
    headers: { Authorization: `PVEAPIToken=${tokenId}=${secret}` },
    verifyTls: envBool(cfg('PROXMOX_VERIFY_TLS')),
  });
  if (!res || !res.ok) {
    if (res) console.error(`[homelab] proxmox HTTP ${res.status}`);
    return null;
  }
  const json = (res.data ?? {}) as { data?: PveResource[] };
  const data = json.data ?? [];
  const nodes = data.filter((r) => r.type === 'node');
  if (nodes.length === 0) return null;

  let cpuWeighted = 0;
  let cores = 0;
  let memUsed = 0;
  let memTotal = 0;
  let uptime = 0;
  let online = 0;
  for (const n of nodes) {
    const nc = n.maxcpu ?? 0;
    cores += nc;
    cpuWeighted += (n.cpu ?? 0) * nc;
    memUsed += n.mem ?? 0;
    memTotal += n.maxmem ?? 0;
    uptime = Math.max(uptime, n.uptime ?? 0);
    if ((n.status ?? '').toLowerCase() === 'online') online++;
  }
  const GB = 1024 ** 3;
  return {
    load: cores > 0 ? Math.round((cpuWeighted / cores) * 100) : 0,
    cores,
    memUsedGB: Math.round(memUsed / GB),
    memTotalGB: Math.round(memTotal / GB),
    vms: data.filter((r) => r.type === 'qemu').length,
    containers: data.filter((r) => r.type === 'lxc').length,
    uptimeSeconds: uptime,
    nodesOnline: online,
    nodesTotal: nodes.length,
  };
}

// ── TrueNAS (JSON-RPC 2.0 over WebSocket) ────────────────────────────────────
// TrueNAS SCALE 25.04 deprecated the REST API and derives access from the linked
// user's roles; the supported interface is JSON-RPC 2.0 over a WebSocket at
// wss://<host>/api/current. We log in with the API key, then read pool capacity +
// uptime — which a least-privilege "Readonly Admin" key can do here. The socket
// (lib/ws-rpc.ts) honors TRUENAS_VERIFY_TLS, so an internal-IP host with a
// hostname-only cert works with verification off.
interface TnPool {
  name?: string;
  size?: number;
  allocated?: number;
  free?: number;
  /** ZFS health flag — false on degraded/corrupt pools even while status is ONLINE. */
  healthy?: boolean;
}

interface TrueNasResult {
  /** WebSocket connected → the box is up. */
  reachable: boolean;
  /** False when any pool reports unhealthy (degraded/corrupt). */
  poolsHealthy: boolean;
  /** Pool totals when the key can read them, else null (caller falls back). */
  storage: { usedTB: number; totalTB: number } | null;
  /** System uptime in seconds, when readable. */
  uptimeSeconds: number | null;
}

interface TnRaw {
  reachable: boolean;
  authOk: boolean;
  pools: TnPool[] | null;
  uptimeSeconds: number | null;
}

function truenasRpc(host: string, key: string, verifyTls: boolean): Promise<TnRaw> {
  const wsUrl = host.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/api/current';
  return new Promise<TnRaw>((resolve) => {
    const out: TnRaw = { reachable: false, authOk: false, pools: null, uptimeSeconds: null };
    let settled = false;
    let ws: LabSocket;
    let gotPools = false;
    let gotInfo = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(out);
    };
    const timer = setTimeout(done, TIMEOUT_MS);

    try {
      ws = openLabSocket(wsUrl, verifyTls);
    } catch {
      return done();
    }

    const send = (id: number, method: string, params: unknown[] = []) =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    const maybeDone = () => {
      if (gotPools && gotInfo) done();
    };

    ws.addEventListener('open', () => {
      out.reachable = true;
      send(1, 'auth.login_with_api_key', [key]);
    });
    ws.addEventListener('error', done);
    ws.addEventListener('close', done);
    ws.addEventListener('message', (ev: { data: string }) => {
      let msg: { id?: number; result?: unknown };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.result === true) {
          out.authOk = true;
          send(2, 'pool.query');
          send(3, 'system.info');
        } else {
          done(); // reached TrueNAS, key rejected → up, no data
        }
      } else if (msg.id === 2) {
        out.pools = Array.isArray(msg.result) ? (msg.result as TnPool[]) : [];
        gotPools = true;
        maybeDone();
      } else if (msg.id === 3) {
        const info = (msg.result ?? {}) as { uptime_seconds?: number };
        out.uptimeSeconds =
          typeof info.uptime_seconds === 'number' ? Math.round(info.uptime_seconds) : null;
        gotInfo = true;
        maybeDone();
      }
    });
  });
}

// Pool capacity barely moves minute to minute, but the RPC occasionally misses
// its window — without a hold, every miss dropped storage to null and the
// landing fell back to the static placeholder. Same pattern as lib/console.ts.
let lastGoodTrueNas: { at: number; value: TrueNasResult } | null = null;
const TRUENAS_HOLD_MS = 10 * 60 * 1000;

async function probeTrueNas(): Promise<TrueNasResult> {
  const host = cfg('TRUENAS_HOST');
  const key = cfg('TRUENAS_API_KEY');
  if (!host || !key) {
    return { reachable: false, poolsHealthy: true, storage: null, uptimeSeconds: null };
  }

  const raw = await truenasRpc(host, key, envBool(cfg('TRUENAS_VERIFY_TLS')));
  const held =
    lastGoodTrueNas && Date.now() - lastGoodTrueNas.at < TRUENAS_HOLD_MS
      ? lastGoodTrueNas.value
      : null;
  if (!raw.reachable) {
    return held ?? { reachable: false, poolsHealthy: true, storage: null, uptimeSeconds: null };
  }

  let storage: { usedTB: number; totalTB: number } | null = null;
  let poolsHealthy = true;
  if (raw.pools && raw.pools.length > 0) {
    let used = 0;
    let total = 0;
    for (const p of raw.pools) {
      const size = p.size ?? 0;
      const alloc = p.allocated ?? (size && p.free != null ? size - p.free : 0);
      total += size;
      used += alloc;
      if (p.healthy === false) poolsHealthy = false;
    }
    if (total > 0) {
      const TB = 1000 ** 4; // storage marketed in decimal TB
      const round1 = (n: number) => Math.round((n / TB) * 10) / 10; // keep one decimal
      storage = { usedTB: round1(used), totalTB: round1(total) };
    }
  }
  if (storage == null) {
    // Reachable but the pool reply missed the window — partial read, serve the
    // recent good one rather than flapping to the placeholder.
    return held ?? { reachable: true, poolsHealthy, storage: null, uptimeSeconds: raw.uptimeSeconds };
  }
  const result: TrueNasResult = {
    reachable: true,
    poolsHealthy,
    storage,
    uptimeSeconds: raw.uptimeSeconds,
  };
  lastGoodTrueNas = { at: Date.now(), value: result };
  return result;
}

// ── Health pings (up/down only) ──────────────────────────────────────────────
// A reachable service that answers ANY HTTP status is "up" — a 401/403/redirect
// still proves the box is online, which is all these badges claim. We only call it
// down when the request can't complete at all, and we retry once first so a single
// slow round-trip through the reverse proxy doesn't flip a healthy service to
// "offline" (and poison the recorded history with a phantom outage).
async function pingOk(url: string, headers: Record<string, string>, verifyTls: boolean) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await labFetch(url, { headers, verifyTls });
    if (res) return res.status > 0; // got an HTTP response → reachable
  }
  return false; // couldn't reach it on either attempt
}

async function probeJellyfin(): Promise<boolean | null> {
  const host = cfg('JELLYFIN_HOST');
  if (!host) return null;
  // Lightweight liveness endpoint (plain "Healthy"), no key needed.
  return pingOk(`${trimSlash(host)}/health`, {}, true);
}

async function probeHomeAssistant(): Promise<boolean | null> {
  const host = cfg('HOMEASSISTANT_HOST');
  const token = cfg('HOMEASSISTANT_TOKEN');
  if (!host || !token) return null;
  return pingOk(`${trimSlash(host)}/api/`, { Authorization: `Bearer ${token}` }, true);
}

function levelFor(affected: number): HealthLevel {
  if (affected === 0) return 'operational';
  if (affected <= 2) return 'partial';
  return 'degraded';
}

let cache: { at: number; value: HomelabSummary | null } | null = null;
let inflight: Promise<HomelabSummary | null> | null = null;

async function build(): Promise<HomelabSummary | null> {
  const [pve, truenas, jelly, ha] = await Promise.all([
    probeProxmox(),
    probeTrueNas(),
    probeJellyfin(),
    probeHomeAssistant(),
  ]);

  // Proxmox is the backbone; without it we have no real aggregate to show.
  if (!pve) return null;

  const proxmoxOk = pve.nodesOnline === pve.nodesTotal && pve.nodesTotal > 0;
  // Reachable + healthy pools → ok; reachable + a corrupt/degraded pool → degraded.
  const truenasHealth: SystemHealth = !truenas.reachable
    ? 'down'
    : truenas.poolsHealthy
      ? 'ok'
      : 'degraded';
  const storage = truenas.storage;
  const systems: SystemStat[] = [
    {
      name: 'Proxmox VE',
      health: proxmoxOk ? 'ok' : pve.nodesOnline > 0 ? 'degraded' : 'down',
      uptimeSeconds: pve.uptimeSeconds,
    },
    { name: 'TrueNAS SCALE', health: truenasHealth, uptimeSeconds: truenas.uptimeSeconds },
    {
      name: 'Jellyfin',
      health: jelly == null ? 'ok' : jelly ? 'ok' : 'down',
      uptimeSeconds: null,
    },
    {
      name: 'Home Assistant',
      health: ha == null ? 'ok' : ha ? 'ok' : 'down',
      uptimeSeconds: null,
    },
  ];

  // Persist today's health so the status page can draw a real history over time.
  recordSystems(systems);

  // Aggregate "services" = running guests, the headline count.
  const total = pve.vms + pve.containers;
  const affected = systems.filter((s) => s.health !== 'ok').length;

  return {
    load: pve.load,
    cores: pve.cores,
    memUsedGB: pve.memUsedGB,
    memTotalGB: pve.memTotalGB,
    storageUsedTB: storage?.usedTB ?? null,
    storageTotalTB: storage?.totalTB ?? null,
    vms: pve.vms,
    containers: pve.containers,
    uptimeSeconds: pve.uptimeSeconds,
    services: { total, healthy: total - affected, affected },
    level: levelFor(affected),
    systems,
  };
}

/**
 * Sanitized real homelab summary, cached so visitor bursts don't multiply
 * backend probes. Returns null when Proxmox is unreachable / unconfigured;
 * callers then fall back to the static placeholders in lib/config + lib/status.
 */
export async function getHomelabSummary(): Promise<HomelabSummary | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (!inflight) {
    inflight = build()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .catch((err) => {
        console.error('[homelab] summary failed:', (err as Error)?.message ?? err);
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  // Stale-while-revalidate: an expired cache serves the previous snapshot
  // immediately while the refresh runs in the background; only a cold start
  // (empty cache) waits for real data.
  if (cache) return cache.value;
  return inflight;
}

/**
 * Never-blocking variant for the root layout, which renders on EVERY server
 * render (each navigation, plus the login/logout redirects) and must not wait
 * on a probe burst — an unreachable backend means two 3.5s ping attempts.
 * Returns whatever is cached right now (null on a cold start; callers fall
 * back to placeholders) and triggers a background refresh when stale. The
 * client polls /api/status within seconds, so real data follows immediately.
 */
export function peekHomelabSummary(): HomelabSummary | null {
  if (!cache || Date.now() - cache.at >= CACHE_TTL_MS) void getHomelabSummary();
  return cache?.value ?? null;
}
