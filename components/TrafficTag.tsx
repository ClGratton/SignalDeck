'use client';

import { useTraffic } from '@/components/TrafficProvider';
import styles from './TrafficTag.module.css';

const fmt = new Intl.NumberFormat('en-US');

/**
 * Legend that maps each wire to a subdomain and labels the moving dots as live
 * packets. Renders only when traffic data exists, and says plainly whether it's
 * live Cloudflare data or a local sample, so the viz never overstates itself.
 */
export function TrafficTag() {
  const { traffic } = useTraffic();
  if (!traffic) return null;

  const lanes = traffic.subdomains.slice(0, 3);
  const sourceLabel = traffic.source === 'sample' ? 'sample data' : 'live via Cloudflare';

  return (
    <div className={`${styles.tag} mono`}>
      {lanes.length > 0 ? (
        <ul className={styles.lanes}>
          {lanes.map((s, i) => {
            const dot = s.host.indexOf('.');
            const name = dot === -1 ? s.host : s.host.slice(0, dot);
            const domain = dot === -1 ? '' : s.host.slice(dot);
            return (
              <li className={styles.lane} data-lane={i} key={s.host}>
                <span className={styles.dot} aria-hidden />
                <span className={styles.host}>
                  <span className={styles.hostName}>{name}</span>
                  {domain ? <span className={styles.hostDomain}>{domain}</span> : null}
                </span>
                <span className={`${styles.rate} tnum`}>
                  {s.rate > 0 ? `${s.rate} req/min` : 'idle'}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <span className={styles.host}>
          <span className={`${styles.rate} tnum`}>{fmt.format(traffic.total)}</span> requests in the
          last {traffic.windowMinutes} min
        </span>
      )}
      <span className={styles.src} data-source={traffic.source}>
        {sourceLabel}
      </span>
    </div>
  );
}
