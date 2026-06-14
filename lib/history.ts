// ─────────────────────────────────────────────────────────────────────────────
// Per-service daily status history for the public status page.
//
// CLIENT-SAFE: types + a pure builder, no fs/server imports. The builder turns a
// recorded history map (worst level observed per service per day) into the
// calendar shape. Real samples are written server-side by lib/history-store.ts;
// days with no recorded sample render as "no data" (not a fake outage), and days
// in the future render as "future". Stays sanitized: public service names + a
// coarse daily level, nothing identifying.
// ─────────────────────────────────────────────────────────────────────────────

import { systems } from '@/lib/config';

/** A day we actually recorded a sample for. */
export type RecordedLevel = 'ok' | 'partial' | 'down';
/** Calendar cell level: recorded levels + "no data" (past, unrecorded) + "future". */
export type DayLevel = RecordedLevel | 'none' | 'future';

/** Rich per-day entry: worst level + observed minutes in each incident state.
 *  Minutes accrue from real probe samples, so they UNDER-count quiet periods —
 *  honest "observed downtime", never invented. */
export interface DayDetail {
  lvl: RecordedLevel;
  /** Minutes observed in 'partial' (degraded) this day. */
  pMin?: number;
  /** Minutes observed in 'down' this day. */
  dMin?: number;
}

/** A stored day: legacy bare level string, or the rich detail object. */
export type HistoryEntry = RecordedLevel | DayDetail;

/** Recorded history: { [serviceName]: { 'YYYY-MM-DD': entry } }. */
export type HistoryRecord = Record<string, Record<string, HistoryEntry>>;

/** The level of any entry, old or new. */
export function entryLevel(e: HistoryEntry | undefined): RecordedLevel | undefined {
  if (e == null) return undefined;
  return typeof e === 'string' ? e : e.lvl;
}
/** Observed incident minutes; legacy string entries report none. */
export function entryMins(e: HistoryEntry | undefined): { pMin: number; dMin: number } {
  if (e == null || typeof e === 'string') return { pMin: 0, dMin: 0 };
  return { pMin: e.pMin ?? 0, dMin: e.dMin ?? 0 };
}

export interface DayStatus {
  date: string; // YYYY-MM-DD
  day: number;
  /** Weekday of day 1 lives on days[0]; used to align the calendar grid. */
  weekday: number;
  level: DayLevel;
  /** Observed minutes degraded today (omitted when none/unrecorded). */
  partialMins?: number;
  /** Observed minutes down today (omitted when none/unrecorded). */
  downMins?: number;
}

export interface ServiceHistory {
  id: string;
  label: string;
  days: DayStatus[];
  uptimePct: number;
  incidents: number;
  streakDays: number;
}

/** {y, m (0-based), d} snapshot of "now", passed in so generation is deterministic. */
export interface Today {
  y: number;
  m: number;
  d: number;
}

const SEVERITY: Record<DayLevel, number> = { future: -2, none: -1, ok: 0, partial: 1, down: 2 };

const pad = (n: number) => String(n).padStart(2, '0');

export function monthLabelOf(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

export function isCurrentMonth(year: number, month: number, today: Today): boolean {
  return year === today.y && month === today.m;
}

function summarize(id: string, label: string, days: DayStatus[]): ServiceHistory {
  // Only days we actually recorded count toward uptime / incidents.
  const real = days.filter((d) => d.level === 'ok' || d.level === 'partial' || d.level === 'down');
  const sampled = Math.max(1, real.length);
  let down = 0;
  let partial = 0;
  for (const d of real) {
    if (d.level === 'down') down++;
    else if (d.level === 'partial') partial++;
  }
  const uptimePct = Math.round(((100 * (sampled - down - partial * 0.4)) / sampled) * 10) / 10;

  // Operational streak counting back from the most recent recorded day.
  let streak = 0;
  for (let i = real.length - 1; i >= 0; i--) {
    if (real[i].level === 'ok') streak++;
    else break;
  }
  return {
    id,
    label,
    days,
    uptimePct: real.length === 0 ? 100 : uptimePct,
    incidents: down + partial,
    streakDays: streak,
  };
}

export function buildServiceHistories(
  year: number,
  month: number,
  today: Today,
  record: HistoryRecord,
): ServiceHistory[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const isFuture = (d: number) =>
    year > today.y ||
    (year === today.y && (month > today.m || (month === today.m && d > today.d)));

  const perSystem = systems.map((s) => {
    const recorded = record[s.name] ?? {};
    const days: DayStatus[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const weekday = new Date(year, month, d).getDay();
      const date = `${year}-${pad(month + 1)}-${pad(d)}`;
      const entry = recorded[date];
      const level: DayLevel = isFuture(d) ? 'future' : entryLevel(entry) ?? 'none';
      const { pMin, dMin } = entryMins(entry);
      days.push({
        date,
        day: d,
        weekday,
        level,
        partialMins: pMin > 0 ? pMin : undefined,
        downMins: dMin > 0 ? dMin : undefined,
      });
    }
    return summarize(s.name, s.name, days);
  });

  // "All systems" = the worst level across services each day, and the longest
  // single-service incident time (max, not sum — one 3h outage, not 3×1h added).
  const allDays: DayStatus[] = perSystem[0].days.map((d0, i) => {
    let worst: DayLevel = perSystem[0].days[i].level;
    let pMin = 0;
    let dMin = 0;
    for (const sys of perSystem) {
      const day = sys.days[i];
      if (SEVERITY[day.level] > SEVERITY[worst]) worst = day.level;
      pMin = Math.max(pMin, day.partialMins ?? 0);
      dMin = Math.max(dMin, day.downMins ?? 0);
    }
    return {
      ...d0,
      level: worst,
      partialMins: pMin > 0 ? pMin : undefined,
      downMins: dMin > 0 ? dMin : undefined,
    };
  });

  return [summarize('all', 'All systems', allDays), ...perSystem];
}
