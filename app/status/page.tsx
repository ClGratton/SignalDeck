import type { Metadata } from 'next';
import { ThemeToggle } from '@/components/ThemeToggle';
import { ServiceHistory } from '@/components/ServiceHistory';
import { lab } from '@/lib/config';
import { getHistoryRecord } from '@/lib/history-store';
import { buildServiceHistories } from '@/lib/history';
import styles from './status.module.css';

export const metadata: Metadata = {
  title: `${lab.name} — service history`,
};

// Always reflect the latest recorded history.
export const dynamic = 'force-dynamic';

export default function StatusPage() {
  const now = new Date();
  const today = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  const initial = buildServiceHistories(today.y, today.m, today, getHistoryRecord());

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <ThemeToggle />
      </header>

      <main className={styles.main}>
        <div className={styles.intro}>
          <h1 className={styles.title}>Service history</h1>
          <p className={styles.sub}>Daily status across the rack. Pick a service to see its month.</p>
        </div>
        <ServiceHistory today={today} initial={initial} />
      </main>
    </div>
  );
}
