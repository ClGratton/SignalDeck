'use client';

import { useEffect, useState } from 'react';
import { lab } from '@/lib/config';
import styles from './Clock.module.css';

export function Clock() {
  const [parts, setParts] = useState<{ time: string; zone: string } | null>(null);

  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: lab.timeZone,
      timeZoneName: 'short',
    });
    const update = () => {
      const p = fmt.formatToParts(new Date());
      const get = (type: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === type)?.value ?? '';
      setParts({ time: `${get('hour')}:${get('minute')}:${get('second')}`, zone: get('timeZoneName') });
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={styles.clock} suppressHydrationWarning>
      <span className={styles.place}>{lab.place}</span>
      <span className={styles.divider} aria-hidden />
      <span className={`${styles.time} mono tnum`}>{parts ? parts.time : '··:··:··'}</span>
      <span className={`${styles.zone} mono`}>{parts?.zone}</span>
    </div>
  );
}
