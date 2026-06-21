// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: durable per-day status history.
//
// Every real probe (lib/homelab.ts build()) calls recordSystems() with the
// current per-system health. We keep the WORST level observed for each service on
// each calendar day — a single "down" sample marks the day as an incident even if
// it recovered — and write it through to data/status-history.json. The status
// page reads this back to draw a TRUE calendar: recorded days show their real
// level, past days we never sampled show "no data", future days show "future".
//
// Sanitized like everything public-facing: service names + a coarse daily level,
// nothing identifying. A read/write failure degrades to an empty history rather
// than throwing.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@/lib/atomic-write';
import type { SystemHealth } from '@/lib/config';
import { entryLevel, entryMins, type DayDetail, type HistoryRecord, type RecordedLevel } from '@/lib/history';

const FILE = path.join(process.cwd(), 'data', 'status-history.json');
const RANK: Record<RecordedLevel, number> = { ok: 0, partial: 1, down: 2 };

// A single sample attributes the time since the previous sample to the current
// state, but only up to this cap — so a long quiet gap (no page views, or a
// restart) can't dump hours of "downtime" onto whichever state we happen to see
// first. Probes land ~every 15s while the page is watched.
const MAX_GAP_MS = 2 * 60 * 1000;
let lastSampleMs = 0;

function healthToLevel(h: SystemHealth): RecordedLevel {
  return h === 'down' ? 'down' : h === 'degraded' ? 'partial' : 'ok';
}

const pad = (n: number) => String(n).padStart(2, '0');
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// In-memory mirror so reads don't hit disk on every page load. Written through on
// change. Survives within a server process; rebuilt from disk on cold start.
let mem: HistoryRecord | null = null;

function load(): HistoryRecord {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(FILE, 'utf8')) as HistoryRecord;
  } catch {
    mem = {}; // missing/corrupt file → start fresh, no fake data
  }
  return mem;
}

function persist(rec: HistoryRecord): void {
  try {
    writeFileAtomic(FILE, JSON.stringify(rec));
  } catch (err) {
    console.error('[history] write failed:', (err as Error)?.message ?? err);
  }
}

/** Read the full recorded history (cached). Safe for client serialization. */
export function getHistoryRecord(): HistoryRecord {
  return load();
}

/**
 * Fold the current per-system health into today's record, keeping the worst level
 * seen for each service today. Only writes when something actually changed.
 */
export function recordSystems(
  systems: Array<{ name: string; health: SystemHealth }>,
  now: Date = new Date(),
): void {
  const date = dateKey(now);
  const rec = load();
  const ms = now.getTime();
  const elapsedMin = lastSampleMs > 0 ? Math.min(ms - lastSampleMs, MAX_GAP_MS) / 60000 : 0;
  lastSampleMs = ms;

  let changed = false;
  for (const s of systems) {
    const level = healthToLevel(s.health);
    const svc = (rec[s.name] ??= {});
    const cur = svc[date];
    const prevLevel = entryLevel(cur);
    let { pMin, dMin } = entryMins(cur);

    if (elapsedMin > 0) {
      if (level === 'down') dMin += elapsedMin;
      else if (level === 'partial') pMin += elapsedMin;
    }
    const worst: RecordedLevel = prevLevel == null || RANK[level] > RANK[prevLevel] ? level : prevLevel;

    // Write when the level rose, when we added incident time, or to migrate a
    // legacy bare-string entry to the rich shape.
    const accrued = elapsedMin > 0 && (level === 'down' || level === 'partial');
    if (prevLevel == null || worst !== prevLevel || accrued || typeof cur === 'string') {
      const next: DayDetail = { lvl: worst };
      if (pMin > 0) next.pMin = Math.round(pMin * 10) / 10;
      if (dMin > 0) next.dMin = Math.round(dMin * 10) / 10;
      svc[date] = next;
      changed = true;
    }
  }
  if (changed) persist(rec);
}
