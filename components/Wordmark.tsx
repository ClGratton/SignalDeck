import { PulseGlyph } from '@/components/PulseGlyph';
import { lab } from '@/lib/config';
import styles from './Wordmark.module.css';

export function Wordmark() {
  return (
    <span className={styles.lockup}>
      <PulseGlyph className={styles.glyph} strokeWidth={2.4} />
      <span className={styles.name}>{lab.name}</span>
    </span>
  );
}
