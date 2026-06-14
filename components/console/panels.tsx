'use client';

// The console's data panels. Each one is shaped by its data — a guest table,
// capacity meters, a sessions list, an entity readout, a sparkline — rather
// than a uniform card grid.

import { useEffect, useState } from 'react';
import type {
  ConsoleHomeAssistant,
  ConsoleJellyfin,
  ConsoleProxmox,
  ConsoleTrueNas,
} from '@/lib/console';
import type { ServiceHistory } from '@/lib/history';
import { useTraffic } from '@/components/TrafficProvider';
import { Panel, Meter, StatusDot, formatUptime, SkeletonRows, Unreachable } from './bits';
import styles from './console.module.css';

// ── Compute (Proxmox) ────────────────────────────────────────────────────────

export function ComputePanel({ data, loading }: { data: ConsoleProxmox | null; loading: boolean }) {
  const meta = data ? (
    <>
      {data.nodesOnline}/{data.nodesTotal} node{data.nodesTotal === 1 ? '' : 's'} · up{' '}
      {formatUptime(data.uptimeSeconds)}
    </>
  ) : null;
  return (
    <Panel title="Compute" area="compute" meta={meta}>
      {loading ? (
        <SkeletonRows rows={5} />
      ) : !data ? (
        <Unreachable name="Proxmox" />
      ) : (
        <>
          <div className={styles.meterPair}>
            <Meter label="cpu" used={data.load} total={100} unit="%" warnAt={0.75} hotAt={0.9} />
            <Meter label="mem" used={data.memUsedGB} total={data.memTotalGB} unit="GB" />
          </div>
          {/* Scrolls only on overspill — panel surface stays free for the
              click-to-open tailored dashboards planned later. */}
          <div className={styles.tableScroll}>
            <table className={styles.guests}>
            <thead>
              <tr>
                <th scope="col">guest</th>
                <th scope="col">state</th>
                <th scope="col" className={styles.num}>
                  cpu
                </th>
                <th scope="col" className={styles.num}>
                  mem
                </th>
                <th scope="col" className={styles.num}>
                  up
                </th>
              </tr>
            </thead>
            <tbody>
              {data.guests.map((g) => {
                const running = g.status === 'running';
                return (
                  <tr key={`${g.type}-${g.vmid}`} data-stopped={!running || undefined}>
                    <td>
                      <span className={styles.guestName}>{g.name}</span>
                      <span className={`${styles.guestId} mono`}>
                        {g.type === 'qemu' ? 'vm' : 'ct'} {g.vmid}
                      </span>
                    </td>
                    <td>
                      <StatusDot
                        tone={running ? 'ok' : g.status === 'stopped' ? 'off' : 'warn'}
                        label={g.status}
                      />
                    </td>
                    <td className={`${styles.num} mono tnum`}>{running ? `${g.cpuPct}%` : '—'}</td>
                    <td className={`${styles.num} mono tnum`}>
                      {running ? `${g.memGB}/${g.maxmemGB}G` : '—'}
                    </td>
                    <td className={`${styles.num} mono tnum`}>
                      {running ? formatUptime(g.uptimeSeconds) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
          {data.guests.length === 0 ? (
            <p className={styles.emptyNote}>No VMs or containers reported.</p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

// ── Storage (TrueNAS) ────────────────────────────────────────────────────────

export function StoragePanel({ data, loading }: { data: ConsoleTrueNas | null; loading: boolean }) {
  const hottest = data && data.temps.length > 0 ? Math.max(...data.temps.map((t) => t.celsius)) : null;
  const meta = data?.uptimeSeconds != null ? <>up {formatUptime(data.uptimeSeconds)}</> : null;
  return (
    <Panel title="Storage" area="storage" meta={meta}>
      {loading ? (
        <SkeletonRows rows={4} />
      ) : !data ? (
        <Unreachable name="TrueNAS" />
      ) : data.pools.length === 0 && data.datasets.length === 0 ? (
        <p className={styles.emptyNote}>Reachable, but no pool data came back this cycle.</p>
      ) : (
        <>
          {data.pools.map((p) => (
            <div key={p.name} className={styles.poolRow}>
              <Meter label={p.name} used={p.usedTB} total={p.totalTB} unit="TB" />
              {!p.healthy ? <StatusDot tone="warn" label="degraded" /> : null}
            </div>
          ))}
          {data.datasets.length > 0 ? (
            <ul className={`${styles.datasets} ${styles.listScroll}`}>
              {data.datasets.map((d) => (
                <li key={d.name}>
                  <span className={`${styles.datasetName} mono`}>{d.name}</span>
                  <span className={`${styles.datasetUse} mono tnum`}>
                    {d.usedGB >= 1000 ? `${Math.round(d.usedGB / 100) / 10}T` : `${Math.round(d.usedGB)}G`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {data.temps.length > 0 ? (
            <p className={`${styles.temps} mono tnum`}>
              disks {Math.min(...data.temps.map((t) => t.celsius))}–{hottest}°C
              {hottest != null && hottest >= 50 ? <StatusDot tone="warn" label="hot" /> : null}
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}

// ── Media (Jellyfin) ─────────────────────────────────────────────────────────

export function MediaPanel({ data, loading }: { data: ConsoleJellyfin | null; loading: boolean }) {
  const playing = data?.sessions.filter((s) => s.playing != null) ?? [];
  return (
    <Panel
      title="Media"
      area="media"
      meta={data?.online ? `${playing.length} playing` : undefined}
    >
      {loading ? (
        <SkeletonRows rows={3} />
      ) : !data || !data.online ? (
        <Unreachable name="Jellyfin" />
      ) : data.sessions.length === 0 ? (
        <p className={styles.emptyNote}>Nobody is connected.</p>
      ) : (
        <ul className={`${styles.sessions} ${styles.listScroll}`}>
          {data.sessions.map((s, i) => (
            <li key={`${s.user}-${i}`} className={styles.session}>
              <div className={styles.sessionWho}>
                <span className={styles.sessionUser}>{s.user}</span>
                <span className={`${styles.sessionClient} mono`}>{s.client}</span>
              </div>
              {s.playing ? (
                <>
                  <p className={styles.sessionTitle}>
                    {s.paused ? '⏸ ' : ''}
                    {s.playing}
                  </p>
                  {s.progressPct != null ? (
                    <span className={styles.progress} role="presentation">
                      <span className={styles.progressFill} style={{ width: `${s.progressPct}%` }} />
                    </span>
                  ) : null}
                </>
              ) : (
                <p className={styles.sessionIdle}>idle</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Automation (Home Assistant) ──────────────────────────────────────────────

export function AutomationPanel({
  data,
  loading,
}: {
  data: ConsoleHomeAssistant | null;
  loading: boolean;
}) {
  return (
    <Panel
      title="Automation"
      area="automation"
      meta={data?.online ? `${data.totalEntities} entities` : undefined}
    >
      {loading ? (
        <SkeletonRows rows={4} />
      ) : !data || !data.online ? (
        <Unreachable name="Home Assistant" />
      ) : data.entities.length === 0 ? (
        <p className={styles.emptyNote}>
          Nothing pinned. Set <code className="mono">HOMEASSISTANT_ENTITIES</code> or ask the
          assistant what exists.
        </p>
      ) : (
        <ul className={`${styles.entities} ${styles.listScroll}`}>
          {data.entities.map((e) => (
            <li key={e.id} className={styles.entity}>
              <span className={styles.entityName} title={e.id}>
                {e.name}
              </span>
              <span className={`${styles.entityState} mono tnum`} data-on={e.state === 'on' || undefined}>
                {e.state}
                {e.unit ? ` ${e.unit}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Traffic (Cloudflare, shared provider) ────────────────────────────────────

export function TrafficPanel() {
  const { traffic } = useTraffic();
  const points = traffic?.points ?? [];
  const max = Math.max(1, ...points);
  const path = points
    .map((v, i) => `${(i / Math.max(1, points.length - 1)) * 100},${34 - (v / max) * 30}`)
    .join(' ');
  return (
    <Panel
      title="Traffic"
      area="traffic"
      meta={traffic ? `${traffic.total} req / ${traffic.windowMinutes}m` : undefined}
    >
      {!traffic ? (
        <p className={styles.emptyNote}>Cloudflare integration is off.</p>
      ) : (
        <>
          <svg className={styles.spark} viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden>
            <polyline className={styles.sparkLine} points={path} />
          </svg>
          <ul className={styles.lanes}>
            {traffic.subdomains.map((s) => (
              <li key={s.host}>
                <span className={`${styles.laneHost} mono`}>{s.host}</span>
                <span className={`${styles.laneRate} mono tnum`}>{s.rate}/min</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

// ── History strip (recorded daily health, current month) ────────────────────

export function HistoryStrip() {
  const [histories, setHistories] = useState<ServiceHistory[] | null>(null);
  useEffect(() => {
    const now = new Date();
    let alive = true;
    fetch(`/api/history?year=${now.getFullYear()}&month=${now.getMonth()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { histories?: ServiceHistory[] } | null) => {
        if (alive && data && Array.isArray(data.histories)) setHistories(data.histories);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Panel
      title="History"
      area="history"
      meta={
        <a
          href="/status?from=console"
          target="_blank"
          rel="noopener"
          className={styles.historyLink}
          title="Opens in a new tab so the console (and any running assistant turn) keeps going"
        >
          full status page →
        </a>
      }
    >
      {!histories ? (
        <SkeletonRows rows={2} />
      ) : (
        <div className={styles.historyRows}>
          {histories.map((h) => (
            <div key={h.id} className={styles.historyRow}>
              <span className={styles.historyLabel}>{h.label}</span>
              <span className={styles.historyCells} aria-label={`${h.label}: ${h.uptimePct}% uptime this month`}>
                {h.days
                  .filter((d) => d.level !== 'future')
                  .map((d) => (
                    <span
                      key={d.date}
                      className={styles.historyCell}
                      data-level={d.level}
                      title={`${d.date}: ${d.level === 'none' ? 'no data' : d.level}`}
                    />
                  ))}
              </span>
              <span className={`${styles.historyPct} mono tnum`}>{h.uptimePct}%</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
