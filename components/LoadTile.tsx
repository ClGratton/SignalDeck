'use client';

import type { CSSProperties } from 'react';
import { useStatus } from '@/components/StatusProvider';
import { loadLevel } from '@/lib/status';
import styles from '@/app/page.module.css';

// A sixth spec tile carrying the live compute load. Reuses the .spec shell so it
// sits flush with the static tiles; a thin bar along the bottom is the colored
// gauge (green / amber / red by threshold).
export function LoadTile() {
  const { status } = useStatus();
  const load = Math.round(status.load ?? 0);
  const level = loadLevel(load);

  return (
    <li className={`${styles.spec} ${styles.loadSpec}`}>
      <span className={`${styles.specValue} mono tnum`}>
        {load}
        <span className={styles.specUnit}>%</span>
      </span>
      <span className={`${styles.specLabel} mono`}>load</span>
      <span
        className={styles.loadBar}
        data-level={level}
        style={{ ['--load' as string]: `${load}%` } as CSSProperties}
        aria-hidden
      />
    </li>
  );
}
