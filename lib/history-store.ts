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
import type { SystemHealth } from '@/lib/config';
import type { HistoryRecord, RecordedLevel } from '@/lib/history';

const FILE = path.join(process.cwd(), 'data', 'status-history.json');
const RANK: Record<RecordedLevel, number> = { ok: 0, partial: 1, down: 2 };

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
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(rec));
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
  let changed = false;
  for (const s of systems) {
    const level = healthToLevel(s.health);
    const svc = (rec[s.name] ??= {});
    const cur = svc[date];
    if (cur == null || RANK[level] > RANK[cur]) {
      svc[date] = level;
      changed = true;
    }
  }
  if (changed) persist(rec);
}
