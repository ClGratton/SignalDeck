import type { CSSProperties } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Clock } from '@/components/Clock';
import { PulseGlyph } from '@/components/PulseGlyph';
import { StatusPulse } from '@/components/StatusPulse';
import { TrafficTag } from '@/components/TrafficTag';
import { LoadTile } from '@/components/LoadTile';
import { AuthDoor } from '@/components/AuthDoor';
import { hasValidSession } from '@/lib/session';
import { peekHomelabSummary } from '@/lib/homelab';
import { bragStats, lab, links, stack, type BragStat } from '@/lib/config';
import styles from './page.module.css';

const boot = (i: number): CSSProperties => ({ ['--i' as string]: i }) as CSSProperties;

export default async function HomePage() {
  // peek, not await: sign-out lands here and must not hang on a cold probe
  // burst. A cold start shows the static placeholder specs for one render;
  // the cache warms in the background within seconds.
  const [authed, summary] = [await hasValidSession(), peekHomelabSummary()];
  const door = authed
    ? { href: '/dashboard', label: 'Enter console' }
    : { href: '/login', label: 'Authenticate' };

  // Real rig specs from Proxmox/TrueNAS where available; static placeholders else.
  // Storage falls back on its own when TrueNAS can't report pools.
  const storageBrag = bragStats.find((s) => s.label === 'storage');
  const specs: BragStat[] = summary
    ? [
        { label: 'cores', value: String(summary.cores) },
        { label: 'memory', value: String(summary.memTotalGB), unit: 'GB', used: String(summary.memUsedGB) },
        summary.storageTotalTB != null
          ? {
              label: 'storage',
              value: summary.storageTotalTB.toFixed(1),
              unit: 'TB',
              used: (summary.storageUsedTB ?? 0).toFixed(1),
            }
          : (storageBrag ?? { label: 'storage', value: '0', unit: 'TB' }),
        { label: 'containers', value: String(summary.containers) },
        { label: 'vms', value: String(summary.vms) },
      ]
    : bragStats;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerRight}>
          <Clock />
          <ThemeToggle />
        </div>
      </header>

      <main className={styles.hero}>
        <div className={styles.heroInner}>
          <PulseGlyph className={`${styles.heroGlyph} boot`} strokeWidth={2.2} />
          <h1 className={`${styles.title} boot`} style={boot(1)}>
            {lab.name}
          </h1>
          <p className={`${styles.tagline} boot`} style={boot(2)}>
            {lab.tagline}
          </p>
          <div className={`${styles.pulseRow} boot`} style={boot(3)}>
            <StatusPulse />
          </div>
          <div className={`${styles.doorRow} boot`} style={boot(4)}>
            <AuthDoor href={door.href} label={door.label} />
          </div>
          <div className={`${styles.trafficRow} boot`} style={boot(5)}>
            <TrafficTag />
          </div>
          <ul className={`${styles.specs} boot`} style={boot(6)} aria-label="Rig specs">
            {specs.map((s) => (
              <li className={styles.spec} key={s.label}>
                <span className={`${styles.specValue} mono tnum`}>
                  {s.used ? (
                    <>
                      {s.used}
                      <span className={styles.specOf}>/{s.value}</span>
                    </>
                  ) : (
                    s.value
                  )}
                  {s.unit ? <span className={styles.specUnit}>{s.unit}</span> : null}
                </span>
                <span className={`${styles.specLabel} mono`}>{s.label}</span>
              </li>
            ))}
            <LoadTile />
          </ul>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footRow}>
          <div className={styles.stack}>
            <span className={`${styles.footLabel} mono`}>powered by</span>
            <ul className={styles.stackList}>
              {stack.map((s) => (
                <li className={styles.stackItem} key={s.name}>
                  <span className={styles.stackName}>{s.name}</span>
                  <span className={`${styles.stackRole} mono`}>{s.role}</span>
                </li>
              ))}
            </ul>
          </div>

          <nav className={styles.links} aria-label="External links">
            {links.map((l) => {
              const external = l.href.startsWith('http');
              return (
                <a
                  key={l.label}
                  href={l.href}
                  className={styles.link}
                  {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
                >
                  {l.label}
                </a>
              );
            })}
            <span className={`${styles.version} mono`}>{lab.version}</span>
          </nav>
        </div>
      </footer>
    </div>
  );
}
