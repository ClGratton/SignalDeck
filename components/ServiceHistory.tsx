'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  isCurrentMonth,
  monthLabelOf,
  type DayLevel,
  type ServiceHistory as ServiceHistoryData,
  type Today,
} from '@/lib/history';
import styles from './ServiceHistory.module.css';

const LEVEL_LABEL: Record<DayLevel, string> = {
  ok: 'Operational',
  partial: 'Partial outage',
  down: 'Down',
  none: 'No data',
  future: 'Upcoming',
};

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function MonthGrid({ svc }: { svc: ServiceHistoryData }) {
  const leadBlanks = svc.days[0]?.weekday ?? 0;
  return (
    <div className={styles.grid} role="grid" aria-label={`${svc.label} daily status`}>
      {WEEKDAYS.map((w, i) => (
        <span key={`w${i}`} className={`${styles.weekday} mono`} aria-hidden>
          {w}
        </span>
      ))}
      {Array.from({ length: leadBlanks }).map((_, i) => (
        <span key={`b${i}`} className={styles.blank} aria-hidden />
      ))}
      {svc.days.map((d) => (
        <span
          key={d.date}
          className={`${styles.cell} mono tnum`}
          data-level={d.level}
          title={`${d.date} · ${LEVEL_LABEL[d.level]}`}
          role="gridcell"
          aria-label={`${d.date}: ${LEVEL_LABEL[d.level]}`}
        >
          {d.day}
        </span>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div className={styles.legend}>
      {(['ok', 'partial', 'down', 'none'] as const).map((lv) => (
        <span key={lv} className={styles.legendItem}>
          <span className={styles.swatch} data-level={lv} aria-hidden />
          {lv === 'none' ? 'no data' : LEVEL_LABEL[lv].toLowerCase()}
        </span>
      ))}
    </div>
  );
}

const monthKey = (y: number, m: number) => `${y}-${m}`;

export function ServiceHistory({
  today,
  initial,
}: {
  today: Today;
  initial: ServiceHistoryData[];
}) {
  const [year, setYear] = useState(today.y);
  const [month, setMonth] = useState(today.m);
  const [id, setId] = useState('all');

  // Months fetched so far, keyed by "year-month". The current month is seeded from
  // the server so there's no flash; other months load on demand.
  const cacheRef = useRef<Map<string, ServiceHistoryData[]>>(
    new Map([[monthKey(today.y, today.m), initial]]),
  );
  const [histories, setHistories] = useState<ServiceHistoryData[]>(initial);

  useEffect(() => {
    const key = monthKey(year, month);
    const cached = cacheRef.current.get(key);
    if (cached) {
      setHistories(cached);
      return;
    }
    let active = true;
    fetch(`/api/history?year=${year}&month=${month}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { histories: ServiceHistoryData[] } | null) => {
        if (!active || !data) return;
        cacheRef.current.set(key, data.histories);
        setHistories(data.histories);
      })
      .catch(() => {
        /* keep showing the last month on a failed fetch */
      });
    return () => {
      active = false;
    };
  }, [year, month]);

  const selected = histories.find((h) => h.id === id) ?? histories[0];

  const atCurrent = isCurrentMonth(year, month, today);
  const shift = (delta: number) => {
    if (delta > 0 && atCurrent) return; // never navigate into the future
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  if (!selected) return null;

  const monthNav = (
    <div className={styles.monthNav}>
      <button type="button" className={styles.navBtn} onClick={() => shift(-1)} aria-label="Previous month">
        <ChevronLeft size={16} strokeWidth={2.2} aria-hidden />
      </button>
      <span className={`${styles.month} mono`}>{monthLabelOf(year, month)}</span>
      <button
        type="button"
        className={styles.navBtn}
        onClick={() => shift(1)}
        disabled={atCurrent}
        aria-label="Next month"
      >
        <ChevronRight size={16} strokeWidth={2.2} aria-hidden />
      </button>
    </div>
  );

  return (
    <div className={styles.wrap}>
      {/* Phone: pick one service, see it large. */}
      <div className={styles.mobileView}>
        <div className={styles.tabs} role="tablist" aria-label="Service">
          {histories.map((h) => (
            <button
              key={h.id}
              type="button"
              role="tab"
              aria-selected={h.id === id}
              className={styles.tab}
              data-active={h.id === id}
              onClick={() => setId(h.id)}
            >
              {h.label}
            </button>
          ))}
        </div>

        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={`${styles.statValue} mono tnum`}>
              {selected.uptimePct}
              <span className={styles.statUnit}>%</span>
            </span>
            <span className={styles.statLabel}>uptime this month</span>
          </div>
          <div className={styles.stat}>
            <span className={`${styles.statValue} mono tnum`}>{selected.incidents}</span>
            <span className={styles.statLabel}>incident days</span>
          </div>
          <div className={styles.stat}>
            <span className={`${styles.statValue} mono tnum`}>
              {selected.streakDays}
              <span className={styles.statUnit}>d</span>
            </span>
            <span className={styles.statLabel}>operational streak</span>
          </div>
        </div>

        <div className={styles.calendar}>
          <div className={styles.calHead}>
            {monthNav}
            <Legend />
          </div>
          <MonthGrid svc={selected} />
        </div>
      </div>

      {/* Desktop: the whole rack's month at once — no selector, fills the width. */}
      <div className={styles.desktopView}>
        <div className={styles.topbar}>
          {monthNav}
          <Legend />
        </div>
        <div className={styles.calGrid}>
          {histories.map((h) => (
            <article key={h.id} className={styles.calCard}>
              <header className={styles.calCardHead}>
                <span className={styles.calCardName}>{h.label}</span>
                <span className={styles.calCardMeta}>
                  <span className="mono tnum">{h.uptimePct}%</span> uptime
                  {h.incidents > 0 ? (
                    <>
                      {' · '}
                      <span className="mono tnum">{h.incidents}</span> incident
                      {h.incidents === 1 ? '' : 's'}
                    </>
                  ) : null}
                </span>
              </header>
              <MonthGrid svc={h} />
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
