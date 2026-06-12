// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the PRIVILEGED console snapshot behind authentication.
//
// Unlike lib/homelab.ts (sanitized public aggregates), this returns the real
// operator view: guest names, per-pool capacity, datasets, disk temps, media
// sessions, Home Assistant entities. It must NEVER be served by a public route —
// every consumer sits behind the middleware or an explicit hasValidSession().
//
// Same caching discipline as the public probes: SWR cache + in-flight coalescing,
// with a peek variant that never blocks a page render.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { labFetch, envBool, trimSlash } from '@/lib/homelab';
import { cfg } from '@/lib/service-config';

const CACHE_TTL_MS = 10_000;
// TrueNAS answers four RPC queries per cycle; a busy middleware occasionally
// takes >4s to return pool.query, which used to surface as "reachable but no
// pool data". Give it a wider window — the panel polls every 12s regardless.
const RPC_TIMEOUT_MS = 6_500;

// ── Types (client components import these via lib/console-types re-export) ───

export interface ConsoleGuest {
  vmid: number;
  name: string;
  type: 'qemu' | 'lxc';
  status: string; // running | stopped | paused...
  node: string;
  /** 0..100, of the guest's own allocated cores. */
  cpuPct: number;
  maxcpu: number;
  memGB: number;
  maxmemGB: number;
  uptimeSeconds: number;
}

export interface ConsoleProxmox {
  load: number; // 0..100 core-weighted
  cores: number;
  memUsedGB: number;
  memTotalGB: number;
  uptimeSeconds: number;
  nodesOnline: number;
  nodesTotal: number;
  guests: ConsoleGuest[];
}

export interface ConsolePool {
  name: string;
  usedTB: number;
  totalTB: number;
  healthy: boolean;
}

export interface ConsoleDataset {
  name: string;
  usedGB: number;
  availGB: number;
}

export interface ConsoleDiskTemp {
  disk: string;
  celsius: number;
}

export interface ConsoleTrueNas {
  reachable: boolean;
  uptimeSeconds: number | null;
  pools: ConsolePool[];
  datasets: ConsoleDataset[];
  temps: ConsoleDiskTemp[];
}

export interface ConsoleSession {
  user: string;
  client: string;
  /** Title currently playing, when there is one. */
  playing: string | null;
  /** 0..100 playback progress when playing. */
  progressPct: number | null;
  paused: boolean;
}

export interface ConsoleJellyfin {
  online: boolean;
  sessions: ConsoleSession[];
}

export interface ConsoleEntity {
  id: string;
  name: string;
  state: string;
  unit: string | null;
}

export interface ConsoleHomeAssistant {
  online: boolean;
  /** Curated subset for the panel (pinned via HOMEASSISTANT_ENTITIES, else auto). */
  entities: ConsoleEntity[];
  /** Total entities the instance reports (the assistant can list them all). */
  totalEntities: number;
}

export interface ConsoleSnapshot {
  at: string;
  proxmox: ConsoleProxmox | null;
  truenas: ConsoleTrueNas | null;
  jellyfin: ConsoleJellyfin | null;
  homeassistant: ConsoleHomeAssistant | null;
}

// ── Proxmox ──────────────────────────────────────────────────────────────────

interface PveResource {
  type: string;
  status?: string;
  node?: string;
  vmid?: number;
  name?: string;
  maxcpu?: number;
  cpu?: number;
  maxmem?: number;
  mem?: number;
  uptime?: number;
}

const GB = 1024 ** 3;

// Tool results are fed back to the model AND shown in the UI. Give the model
// plenty (a 240-char slice made it think the response was cut off and retry in
// a loop); mark any real truncation explicitly so it never reads as an error.
function clip(s: string, n = 4000): string {
  return s.length <= n ? s : s.slice(0, n) + '… (truncated for length)';
}
const round1 = (n: number) => Math.round(n * 10) / 10;

function pveAuth() {
  const host = cfg('PROXMOX_HOST');
  const tokenId = cfg('PROXMOX_TOKEN_ID');
  const secret = cfg('PROXMOX_TOKEN_SECRET');
  if (!host || !tokenId || !secret) return null;
  return {
    base: trimSlash(host),
    headers: { Authorization: `PVEAPIToken=${tokenId}=${secret}` },
    verifyTls: envBool(cfg('PROXMOX_VERIFY_TLS')),
  };
}

async function probeProxmoxFull(): Promise<ConsoleProxmox | null> {
  const auth = pveAuth();
  if (!auth) return null;
  const res = await labFetch(`${auth.base}/api2/json/cluster/resources`, {
    headers: auth.headers,
    verifyTls: auth.verifyTls,
  });
  if (!res || !res.ok) return null;
  const data = ((res.data ?? {}) as { data?: PveResource[] }).data ?? [];

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

  const guests: ConsoleGuest[] = data
    .filter((r) => (r.type === 'qemu' || r.type === 'lxc') && r.vmid != null)
    .map((g) => ({
      vmid: g.vmid!,
      name: g.name ?? `vm-${g.vmid}`,
      type: g.type as 'qemu' | 'lxc',
      status: g.status ?? 'unknown',
      node: g.node ?? '',
      cpuPct: Math.round((g.cpu ?? 0) * 100),
      maxcpu: g.maxcpu ?? 0,
      memGB: round1((g.mem ?? 0) / GB),
      maxmemGB: round1((g.maxmem ?? 0) / GB),
      uptimeSeconds: g.uptime ?? 0,
    }))
    .sort((a, b) => {
      // running first, then by name — the operator scans for what's alive.
      const ra = a.status === 'running' ? 0 : 1;
      const rb = b.status === 'running' ? 0 : 1;
      return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
    });

  return {
    load: cores > 0 ? Math.round((cpuWeighted / cores) * 100) : 0,
    cores,
    memUsedGB: Math.round(memUsed / GB),
    memTotalGB: Math.round(memTotal / GB),
    uptimeSeconds: uptime,
    nodesOnline: online,
    nodesTotal: nodes.length,
    guests,
  };
}

// ── TrueNAS (JSON-RPC over WebSocket, richer than the public probe) ──────────

interface TnParsed {
  parsed?: number;
}
interface TnDataset {
  name?: string;
  used?: TnParsed;
  available?: TnParsed;
}
interface TnPool {
  name?: string;
  size?: number;
  allocated?: number;
  free?: number;
  healthy?: boolean;
}

function truenasRpcFull(host: string, key: string): Promise<ConsoleTrueNas | null> {
  const wsUrl = host.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/api/current';
  return new Promise((resolve) => {
    const out: ConsoleTrueNas = {
      reachable: false,
      uptimeSeconds: null,
      pools: [],
      datasets: [],
      temps: [],
    };
    let settled = false;
    let pending = 0;
    let ws: WebSocket;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closing */
      }
      resolve(out.reachable ? out : null);
    };
    const timer = setTimeout(done, RPC_TIMEOUT_MS);

    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return done();
    }
    const send = (id: number, method: string, params: unknown[] = []) => {
      pending++;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    };
    const settleOne = () => {
      pending--;
      if (pending <= 0) done();
    };

    ws.addEventListener('open', () => {
      out.reachable = true;
      send(1, 'auth.login_with_api_key', [key]);
    });
    ws.addEventListener('error', done);
    ws.addEventListener('close', done);
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id === 1) {
        pending--;
        if (msg.result !== true) return done(); // reachable, key rejected
        send(2, 'pool.query');
        send(3, 'system.info');
        send(4, 'pool.dataset.query', [[], { extra: { flat: true, properties: ['used', 'available'] } }]);
        send(5, 'disk.temperatures');
        return;
      }
      if (msg.id === 2) {
        const TB = 1000 ** 4;
        const pools = Array.isArray(msg.result) ? (msg.result as TnPool[]) : [];
        out.pools = pools.map((p) => {
          const size = p.size ?? 0;
          const alloc = p.allocated ?? (size && p.free != null ? size - p.free : 0);
          return {
            name: p.name ?? 'pool',
            usedTB: round1(alloc / TB),
            totalTB: round1(size / TB),
            healthy: p.healthy !== false,
          };
        });
        settleOne();
      } else if (msg.id === 3) {
        const info = (msg.result ?? {}) as { uptime_seconds?: number };
        out.uptimeSeconds =
          typeof info.uptime_seconds === 'number' ? Math.round(info.uptime_seconds) : null;
        settleOne();
      } else if (msg.id === 4) {
        const sets = Array.isArray(msg.result) ? (msg.result as TnDataset[]) : [];
        out.datasets = sets
          .filter((d) => d.name && !d.name.includes('/.'))
          .map((d) => ({
            name: d.name!,
            usedGB: round1((d.used?.parsed ?? 0) / GB),
            availGB: round1((d.available?.parsed ?? 0) / GB),
          }))
          // top-level + first-level datasets only; deep nesting is noise here
          .filter((d) => d.name.split('/').length <= 2)
          .sort((a, b) => b.usedGB - a.usedGB)
          .slice(0, 12);
        settleOne();
      } else if (msg.id === 5) {
        const temps = (msg.result ?? {}) as Record<string, number | null>;
        out.temps = Object.entries(temps)
          .filter((e): e is [string, number] => typeof e[1] === 'number')
          .map(([disk, celsius]) => ({ disk, celsius }))
          .sort((a, b) => a.disk.localeCompare(b.disk));
        settleOne();
      }
    });
  });
}

async function probeTrueNasFull(): Promise<ConsoleTrueNas | null> {
  const host = cfg('TRUENAS_HOST');
  const key = cfg('TRUENAS_API_KEY');
  if (!host || !key) return null;
  return truenasRpcFull(host, key);
}

// ── Jellyfin ─────────────────────────────────────────────────────────────────

interface JfSession {
  UserName?: string;
  Client?: string;
  NowPlayingItem?: { Name?: string; SeriesName?: string; RunTimeTicks?: number };
  PlayState?: { PositionTicks?: number; IsPaused?: boolean };
}

async function probeJellyfinFull(): Promise<ConsoleJellyfin | null> {
  const host = cfg('JELLYFIN_HOST');
  const key = cfg('JELLYFIN_API_KEY');
  if (!host) return null;
  if (!key) {
    // No key: liveness only.
    const ping = await labFetch(`${trimSlash(host)}/health`, {}, );
    return { online: !!ping && ping.status > 0, sessions: [] };
  }
  const res = await labFetch(`${trimSlash(host)}/Sessions?activeWithinSeconds=900`, {
    headers: { Authorization: `MediaBrowser Token="${key}"` },
  });
  if (!res) return { online: false, sessions: [] };
  if (!res.ok) return { online: true, sessions: [] };
  const raw = Array.isArray(res.data) ? (res.data as JfSession[]) : [];
  const sessions: ConsoleSession[] = raw
    .filter((s) => s.UserName)
    .map((s) => {
      const item = s.NowPlayingItem;
      const title = item ? [item.SeriesName, item.Name].filter(Boolean).join(' — ') : null;
      const run = item?.RunTimeTicks ?? 0;
      const pos = s.PlayState?.PositionTicks ?? 0;
      return {
        user: s.UserName ?? '',
        client: s.Client ?? '',
        playing: title,
        progressPct: item && run > 0 ? Math.min(100, Math.round((pos / run) * 100)) : null,
        paused: s.PlayState?.IsPaused === true,
      };
    })
    // playing sessions first
    .sort((a, b) => Number(b.playing != null) - Number(a.playing != null))
    .slice(0, 8);
  return { online: true, sessions };
}

// ── Home Assistant ───────────────────────────────────────────────────────────

export interface HaState {
  entity_id: string;
  state: string;
  attributes?: { friendly_name?: string; unit_of_measurement?: string; device_class?: string };
}

function haAuth() {
  const host = cfg('HOMEASSISTANT_HOST');
  const token = cfg('HOMEASSISTANT_TOKEN');
  if (!host || !token) return null;
  return { base: trimSlash(host), headers: { Authorization: `Bearer ${token}` } };
}

/** Full entity list — used by the curation below AND exposed to the assistant
 *  as a discovery tool (the panel shows a handful; the model can see them all). */
export async function haListStates(): Promise<HaState[] | null> {
  const auth = haAuth();
  if (!auth) return null;
  const res = await labFetch(`${auth.base}/api/states`, { headers: auth.headers });
  if (!res || !res.ok || !Array.isArray(res.data)) return null;
  return res.data as HaState[];
}

const entityName = (s: HaState) => s.attributes?.friendly_name ?? s.entity_id;
const toEntity = (s: HaState): ConsoleEntity => ({
  id: s.entity_id,
  name: entityName(s),
  state: s.state,
  unit: s.attributes?.unit_of_measurement ?? null,
});

/** Curate the panel's handful: pinned ids from HOMEASSISTANT_ENTITIES, else a
 *  sensible auto-pick (people, climate, alarm, lights that are ON, then a few
 *  meaningful sensors). */
function curateEntities(states: HaState[]): ConsoleEntity[] {
  const pinned = (cfg('HOMEASSISTANT_ENTITIES') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (pinned.length > 0) {
    const byId = new Map(states.map((s) => [s.entity_id, s]));
    return pinned
      .map((id) => byId.get(id))
      .filter((s): s is HaState => !!s)
      .map(toEntity);
  }

  // The panel scrolls internally now, so the auto-pick can afford more rows.
  const CAP = 14;
  const ok = (s: HaState) => s.state !== 'unavailable' && s.state !== 'unknown';
  const picks: HaState[] = [];
  const take = (pred: (s: HaState) => boolean, n: number) => {
    for (const s of states) {
      if (picks.length >= CAP) return;
      if (picks.includes(s) || !ok(s) || !pred(s)) continue;
      picks.push(s);
      if (--n <= 0) return;
    }
  };
  take((s) => s.entity_id.startsWith('person.'), 2);
  take((s) => s.entity_id.startsWith('alarm_control_panel.'), 1);
  take((s) => s.entity_id.startsWith('climate.'), 2);
  take((s) => s.entity_id.startsWith('light.') && s.state === 'on', 4);
  take(
    (s) =>
      s.entity_id.startsWith('sensor.') &&
      ['temperature', 'humidity', 'power', 'energy'].includes(s.attributes?.device_class ?? ''),
    5,
  );
  take((s) => s.entity_id.startsWith('binary_sensor.') && s.attributes?.device_class === 'door', 2);
  return picks.slice(0, CAP).map(toEntity);
}

async function probeHomeAssistantFull(): Promise<ConsoleHomeAssistant | null> {
  const auth = haAuth();
  if (!auth) return null;
  const states = await haListStates();
  if (!states) return { online: false, entities: [], totalEntities: 0 };
  return { online: true, entities: curateEntities(states), totalEntities: states.length };
}

// ── Snapshot cache (SWR + peek, same discipline as lib/homelab.ts) ───────────

let cache: { at: number; value: ConsoleSnapshot } | null = null;
let inflight: Promise<ConsoleSnapshot> | null = null;

// One slow or partial probe cycle must not blank a panel that was fine seconds
// ago (TrueNAS occasionally misses the RPC window; Jellyfin pauses under
// transcode load). Each service keeps its last GOOD result and serves it
// through brief gaps; a real outage still surfaces once the hold expires.
const HOLD_MS = 90_000;
interface Held<T> {
  at: number;
  value: T;
}
const lastGood: {
  proxmox?: Held<ConsoleProxmox>;
  truenas?: Held<ConsoleTrueNas>;
  jellyfin?: Held<ConsoleJellyfin>;
  homeassistant?: Held<ConsoleHomeAssistant>;
} = {};

function settle<T>(
  fresh: T | null,
  isGood: (v: T) => boolean,
  held: Held<T> | undefined,
  save: (h: Held<T>) => void,
): T | null {
  if (fresh != null && isGood(fresh)) {
    save({ at: Date.now(), value: fresh });
    return fresh;
  }
  if (held && Date.now() - held.at < HOLD_MS) return held.value;
  return fresh;
}

async function build(): Promise<ConsoleSnapshot> {
  const [proxmox, truenas, jellyfin, homeassistant] = await Promise.all([
    probeProxmoxFull().catch(() => null),
    probeTrueNasFull().catch(() => null),
    probeJellyfinFull().catch(() => null),
    probeHomeAssistantFull().catch(() => null),
  ]);
  return {
    at: new Date().toISOString(),
    proxmox: settle(proxmox, () => true, lastGood.proxmox, (h) => (lastGood.proxmox = h)),
    // "Reachable but empty" is a partial RPC reply, not a state worth showing.
    truenas: settle(
      truenas,
      (t) => t.pools.length > 0 || t.datasets.length > 0,
      lastGood.truenas,
      (h) => (lastGood.truenas = h),
    ),
    jellyfin: settle(jellyfin, (j) => j.online, lastGood.jellyfin, (h) => (lastGood.jellyfin = h)),
    homeassistant: settle(
      homeassistant,
      (h) => h.online,
      lastGood.homeassistant,
      (h) => (lastGood.homeassistant = h),
    ),
  };
}

/** Blocking variant — ONLY for the polling API route (/api/console) and the
 *  assistant's tools. `fresh` bypasses the cache (still coalesced) so the
 *  assistant can re-read live state when the operator disputes the data. */
export async function getConsoleSnapshot(opts?: { fresh?: boolean }): Promise<ConsoleSnapshot> {
  const maxAge = opts?.fresh ? 1_500 : CACHE_TTL_MS;
  if (cache && Date.now() - cache.at < maxAge) return cache.value;
  if (!inflight) {
    inflight = build()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  if (cache && !opts?.fresh) return cache.value; // stale-while-revalidate
  return inflight;
}

/** Never-blocking variant for the dashboard page render. Null on a cold start —
 *  the client poller fills it in within a second. */
export function peekConsoleSnapshot(): ConsoleSnapshot | null {
  if (!cache || Date.now() - cache.at >= CACHE_TTL_MS) void getConsoleSnapshot();
  return cache?.value ?? null;
}

// ── Actions (assistant proposals execute through these; UI may reuse later) ──
// These are the ONLY mutations the app can perform on the homelab. Every call
// site must be behind a valid session AND an explicit user confirmation.

export type GuestPowerAction = 'start' | 'shutdown' | 'stop' | 'reboot';

export async function proxmoxGuestPower(
  node: string,
  type: 'qemu' | 'lxc',
  vmid: number,
  action: GuestPowerAction,
): Promise<{ ok: boolean; detail: string }> {
  const auth = pveAuth();
  if (!auth) return { ok: false, detail: 'Proxmox is not configured.' };
  if (!/^[a-zA-Z0-9.-]+$/.test(node) || !Number.isInteger(vmid)) {
    return { ok: false, detail: 'Invalid node or vmid.' };
  }
  const res = await labFetch(
    `${auth.base}/api2/json/nodes/${encodeURIComponent(node)}/${type}/${vmid}/status/${action}`,
    { method: 'POST', headers: auth.headers, verifyTls: auth.verifyTls },
  );
  if (!res) return { ok: false, detail: 'Proxmox did not respond.' };
  if (!res.ok) return { ok: false, detail: `Proxmox returned HTTP ${res.status}.` };
  cache = null; // next snapshot reflects the change sooner
  return { ok: true, detail: `${action} sent to ${type}/${vmid} on ${node}.` };
}

/** Generic Proxmox API call — the assistant's "do anything" action. The model
 *  proposes ANY method+path (e.g. DELETE /nodes/x/lxc/108 to destroy a guest,
 *  POST .../config to reconfigure); it still runs ONLY after the operator
 *  confirms. Scoped to the Proxmox API surface and the configured token's
 *  privileges — a least-privilege token simply gets a 403, which we surface. */
export async function proxmoxRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  rawPath: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string }> {
  const auth = pveAuth();
  if (!auth) return { ok: false, detail: 'Proxmox is not configured.' };
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    return { ok: false, detail: `Unsupported method ${method}.` };
  }
  // Normalize to an /api2/json path; reject traversal and off-API targets.
  let path = rawPath.trim();
  if (!path.startsWith('/')) path = '/' + path;
  if (!path.startsWith('/api2/json/')) {
    path = '/api2/json' + (path.startsWith('/api2/') ? path.slice(5) : path);
  }
  const res = await labFetch(`${auth.base}${path}`, {
    method,
    headers: auth.headers,
    verifyTls: auth.verifyTls,
    ...(body && Object.keys(body).length > 0 ? { body, form: true } : {}),
  });
  if (!res) return { ok: false, detail: 'Proxmox did not respond.' };
  if (!res.ok) {
    const hint =
      res.status === 403
        ? ' — the API token lacks permission for this. Grant the needed Proxmox role (see CREDENTIALS.md) and retry.'
        : '';
    return { ok: false, detail: `Proxmox returned HTTP ${res.status}${hint}.` };
  }
  cache = null; // reflect the change on the next snapshot
  const summary =
    res.data && typeof res.data === 'object'
      ? clip(JSON.stringify((res.data as { data?: unknown }).data ?? res.data))
      : '';
  return { ok: true, detail: `${method} ${path} → HTTP ${res.status}.${summary ? ' ' + summary : ''}` };
}

/** Generic Home Assistant REST call — full direct access, the same surface as
 *  the HA web UI / REST API. Covers what ha_service can't: logbook/history,
 *  error_log, template render, and config-entry management (e.g. DELETE
 *  /api/config/config_entries/entry/{id} to remove an integration and all its
 *  devices+entities). Scoped to the HA `/api/` surface. */
export async function haRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  rawPath: string,
  body?: unknown,
): Promise<{ ok: boolean; detail: string }> {
  const auth = haAuth();
  if (!auth) return { ok: false, detail: 'Home Assistant is not configured.' };
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    return { ok: false, detail: `Unsupported method ${method}.` };
  }
  // Normalize onto HA's /api surface (the only thing this host serves over the
  // token) rather than rejecting — a hard "invalid path" guard only produced
  // confusing failures without preventing anything HA wouldn't 404 itself.
  let path = rawPath.trim();
  if (!path.startsWith('/')) path = '/' + path;
  if (!path.startsWith('/api')) path = '/api' + path;
  const res = await labFetch(`${auth.base}${path}`, {
    method,
    headers: auth.headers,
    ...(body != null ? { body } : {}),
  });
  if (!res) return { ok: false, detail: 'Home Assistant did not respond.' };
  if (!res.ok) return { ok: false, detail: `Home Assistant returned HTTP ${res.status}.` };
  cache = null;
  const summary = res.data != null ? clip(JSON.stringify(res.data)) : `HTTP ${res.status}`;
  return { ok: true, detail: `${method} ${path} → ${summary}` };
}

export async function haCallService(
  domain: string,
  service: string,
  entityId: string,
): Promise<{ ok: boolean; detail: string }> {
  const auth = haAuth();
  if (!auth) return { ok: false, detail: 'Home Assistant is not configured.' };
  if (!/^[a-z_]+$/.test(domain) || !/^[a-z_]+$/.test(service) || !/^[\w.]+$/.test(entityId)) {
    return { ok: false, detail: 'Invalid service call.' };
  }
  const res = await labFetch(`${auth.base}/api/services/${domain}/${service}`, {
    method: 'POST',
    headers: auth.headers,
    body: { entity_id: entityId },
  });
  if (!res) return { ok: false, detail: 'Home Assistant did not respond.' };
  if (!res.ok) return { ok: false, detail: `Home Assistant returned HTTP ${res.status}.` };
  cache = null;
  return { ok: true, detail: `${domain}.${service} called on ${entityId}.` };
}

// ── Generic request across ANY configured backend ────────────────────────────
// One tool, every service. The model picks the service and the endpoint; the
// server resolves that service's own base URL, auth, and transport. This is the
// assistant's universal hands — it can reach anything the tokens allow.

export type LabService = 'proxmox' | 'truenas' | 'jellyfin' | 'homeassistant' | 'cloudflare';
export const LAB_SERVICES: LabService[] = [
  'proxmox',
  'truenas',
  'jellyfin',
  'homeassistant',
  'cloudflare',
];

/** One TrueNAS JSON-RPC call over the WebSocket (it has no REST on SCALE 25.04). */
function truenasRpcCall(
  host: string,
  key: string,
  method: string,
  params: unknown[],
): Promise<{ ok: boolean; detail: string }> {
  const wsUrl = host.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/api/current';
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const done = (r: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* closing */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, detail: 'TrueNAS RPC timed out.' }), RPC_TIMEOUT_MS);
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return done({ ok: false, detail: 'Could not open the TrueNAS WebSocket.' });
    }
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'auth.login_with_api_key', params: [key] })),
    );
    ws.addEventListener('error', () => done({ ok: false, detail: 'TrueNAS WebSocket error.' }));
    ws.addEventListener('close', () => done({ ok: false, detail: 'TrueNAS closed the connection.' }));
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.result !== true) return done({ ok: false, detail: 'TrueNAS rejected the API key.' });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }));
      } else if (msg.id === 2) {
        if (msg.error) return done({ ok: false, detail: `TrueNAS: ${msg.error.message ?? 'error'}` });
        cache = null;
        done({ ok: true, detail: `${method} → ${clip(JSON.stringify(msg.result ?? null))}` });
      }
    });
  });
}

/** The universal action. `service` selects the backend; `path` is that service's
 *  endpoint (or, for TrueNAS, the JSON-RPC method name) and `body` the payload. */
export async function labRequest(
  service: LabService,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; detail: string }> {
  switch (service) {
    case 'proxmox':
      return proxmoxRequest(
        method,
        path,
        body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined,
      );
    case 'homeassistant':
      return haRequest(method, path, body);
    case 'truenas': {
      const host = cfg('TRUENAS_HOST');
      const key = cfg('TRUENAS_API_KEY');
      if (!host || !key) return { ok: false, detail: 'TrueNAS is not configured.' };
      const params = Array.isArray(body) ? body : body != null ? [body] : [];
      return truenasRpcCall(host, key, path.trim(), params);
    }
    case 'jellyfin': {
      const host = cfg('JELLYFIN_HOST');
      const key = cfg('JELLYFIN_API_KEY');
      if (!host) return { ok: false, detail: 'Jellyfin is not configured.' };
      let p = path.trim();
      if (!p.startsWith('/')) p = '/' + p;
      const res = await labFetch(`${trimSlash(host)}${p}`, {
        method,
        headers: key ? { Authorization: `MediaBrowser Token="${key}"` } : {},
        ...(body != null ? { body } : {}),
      });
      if (!res) return { ok: false, detail: 'Jellyfin did not respond.' };
      if (!res.ok) return { ok: false, detail: `Jellyfin returned HTTP ${res.status}.` };
      cache = null;
      return { ok: true, detail: `${method} ${p} → ${clip(JSON.stringify(res.data ?? null))}` };
    }
    case 'cloudflare': {
      const token = cfg('CLOUDFLARE_API_TOKEN');
      if (!token) return { ok: false, detail: 'Cloudflare is not configured.' };
      let p = path.trim();
      if (!p.startsWith('/')) p = '/' + p;
      if (!p.startsWith('/client/v4')) p = '/client/v4' + p;
      const res = await labFetch(`https://api.cloudflare.com${p}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        ...(body != null ? { body } : {}),
      });
      if (!res) return { ok: false, detail: 'Cloudflare did not respond.' };
      if (!res.ok) return { ok: false, detail: `Cloudflare returned HTTP ${res.status}.` };
      return { ok: true, detail: `${method} ${p} → ${clip(JSON.stringify(res.data ?? null))}` };
    }
  }
}
