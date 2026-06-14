'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useStatus } from '@/components/StatusProvider';
import {
  isCurrentMonth,
  monthLabelOf,
  type DayLevel,
  type DayStatus,
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

const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes → "3 hrs 51 mins" / "47 mins" / "< 1 min". */
function formatDuration(mins: number): string {
  const m = Math.round(mins);
  if (m < 1) return '< 1 min';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const hp = h > 0 ? `${h} hr${h === 1 ? '' : 's'}` : '';
  const mp = mm > 0 ? `${mm} min${mm === 1 ? '' : 's'}` : '';
  return [hp, mp].filter(Boolean).join(' ') || '0 mins';
}

type Pick = { day: DayStatus; svc: ServiceHistoryData; rect: DOMRect };

function MonthGrid({
  svc,
  onShow,
  onHide,
}: {
  svc: ServiceHistoryData;
  onShow: (day: DayStatus, svc: ServiceHistoryData, el: HTMLElement) => void;
  onHide: () => void;
}) {
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
      {svc.days.map((d) =>
        d.level === 'future' ? (
          <span
            key={d.date}
            className={`${styles.cell} mono tnum`}
            data-level={d.level}
            role="gridcell"
            aria-label={`${d.date}: ${LEVEL_LABEL[d.level]}`}
          >
            {d.day}
          </span>
        ) : (
          <button
            key={d.date}
            type="button"
            data-cell
            className={`${styles.cell} ${styles.cellBtn} mono tnum`}
            data-level={d.level}
            aria-label={`${d.date}: ${LEVEL_LABEL[d.level]}`}
            onMouseEnter={(e) => onShow(d, svc, e.currentTarget)}
            onMouseLeave={onHide}
            onFocus={(e) => onShow(d, svc, e.currentTarget)}
            onBlur={onHide}
            onClick={(e) => onShow(d, svc, e.currentTarget)}
          >
            {d.day}
          </button>
        ),
      )}
    </div>
  );
}

function DayPopover({ pick, ongoing, onClose }: { pick: Pick; ongoing: boolean; onClose: () => void }) {
  const { day, svc, rect } = pick;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // Clicks on another day are handled by that cell's onPick; ignore here.
      if (ref.current?.contains(t) || t.closest('[data-cell]')) return;
      onClose();
    };
    const onShift = () => onClose(); // scroll/resize detaches the anchor — just close
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onShift, true);
    window.addEventListener('resize', onShift);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onShift, true);
      window.removeEventListener('resize', onShift);
    };
  }, [onClose]);

  const [y, mo, d] = day.date.split('-').map(Number);
  const dateLabel = new Date(y, mo - 1, d).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const PW = 250;
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - PW / 2, window.innerWidth - PW - 8));
  const placeBelow = window.innerHeight - rect.bottom > 210;
  const style: CSSProperties = placeBelow
    ? { left, top: rect.bottom + 8, width: PW }
    : { left, top: rect.top - 8, width: PW, transform: 'translateY(-100%)' };

  const dMin = day.downMins ?? 0;
  const pMin = day.partialMins ?? 0;
  const incident = day.level === 'down' || day.level === 'partial';

  return createPortal(
    <div ref={ref} role="dialog" aria-label={`${svc.label} on ${dateLabel}`} className={styles.dayPop} style={style}>
      <div className={styles.dayPopHead}>
        <span className={styles.dayPopDate}>{dateLabel}</span>
        <span className={styles.dayPopSvc}>{svc.label}</span>
      </div>

      <div className={styles.dayPopStatus} data-level={day.level}>
        <span className={styles.dayPopSwatch} data-level={day.level} aria-hidden />
        <span className={styles.dayPopWord}>{LEVEL_LABEL[day.level]}</span>
        {ongoing ? <span className={styles.dayPopOngoing}>ongoing</span> : null}
      </div>

      {dMin > 0 || pMin > 0 ? (
        <div className={styles.dayPopDurs}>
          {dMin > 0 ? (
            <div className={styles.dayPopRow}>
              <span className={styles.dayPopRowKey} data-level="down" aria-hidden />
              <span>Down</span>
              <span className={`${styles.dayPopDur} mono tnum`}>{formatDuration(dMin)}</span>
            </div>
          ) : null}
          {pMin > 0 ? (
            <div className={styles.dayPopRow}>
              <span className={styles.dayPopRowKey} data-level="partial" aria-hidden />
              <span>Degraded</span>
              <span className={`${styles.dayPopDur} mono tnum`}>{formatDuration(pMin)}</span>
            </div>
          ) : null}
        </div>
      ) : incident ? (
        <p className={styles.dayPopNote}>Affected this day — duration not recorded.</p>
      ) : day.level === 'ok' ? (
        <p className={styles.dayPopNote}>Operational all day.</p>
      ) : (
        <p className={styles.dayPopNote}>No sample was recorded.</p>
      )}
    </div>,
    document.body,
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
  const [pick, setPick] = useState<Pick | null>(null);

  // Live per-service health → drives the "ongoing" badge for today's cell.
  const { status } = useStatus();

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

  // A month/service change detaches any open popover.
  useEffect(() => setPick(null), [year, month, id]);

  const selected = histories.find((h) => h.id === id) ?? histories[0];

  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((day: DayStatus, svc: ServiceHistoryData, el: HTMLElement) => {
    clearTimeout(hideTimer.current);
    setPick({ day, svc, rect: el.getBoundingClientRect() });
  }, []);
  const hide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPick(null), 90);
  }, []);
  const hideNow = useCallback(() => {
    clearTimeout(hideTimer.current);
    setPick(null);
  }, []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const todayKey = `${today.y}-${pad(today.m + 1)}-${pad(today.d)}`;
  const isOngoing = (p: Pick): boolean => {
    if (p.day.date !== todayKey) return false;
    const affected = (h: string) => h === 'degraded' || h === 'down';
    if (p.svc.id === 'all') return status.systems.some((s) => affected(s.health));
    const match = status.systems.find((s) => s.name === p.svc.label);
    return !!match && affected(match.health);
  };

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
          <MonthGrid svc={selected} onShow={show} onHide={hide} />
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
              <MonthGrid svc={h} onShow={show} onHide={hide} />
            </article>
          ))}
        </div>
      </div>

      {pick ? <DayPopover pick={pick} ongoing={isOngoing(pick)} onClose={hideNow} /> : null}
    </div>
  );
}
