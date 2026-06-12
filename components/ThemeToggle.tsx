'use client';

import { useTheme } from '@/components/ThemeProvider';
import styles from './ThemeToggle.module.css';

// A single celestial body that morphs between sun and moon: the disc is masked by
// a circle that scales in from nothing (full disc → crescent) while the rays
// retract. The thumb slides the length of the track. All of it is CSS, driven by
// [data-theme] on the document, so it stays in lockstep with the page crossfade.
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  const target = isDark ? 'light' : 'dark';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      className={styles.track}
      onClick={toggle}
      aria-label={`Switch to ${target} theme`}
      title={`Switch to ${target} theme`}
    >
      <span className={styles.thumb}>
        <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden focusable="false">
          <mask id="grtlabs-moon-mask">
            <rect x="0" y="0" width="24" height="24" fill="#fff" />
            <circle className={styles.cutout} cx="12" cy="12" r="9" fill="#000" />
          </mask>
          <circle
            className={styles.disc}
            cx="12"
            cy="12"
            r="6"
            fill="currentColor"
            mask="url(#grtlabs-moon-mask)"
          />
          <g className={styles.beams} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="1.2" x2="12" y2="3.4" />
            <line x1="12" y1="20.6" x2="12" y2="22.8" />
            <line x1="3.5" y1="3.5" x2="5.1" y2="5.1" />
            <line x1="18.9" y1="18.9" x2="20.5" y2="20.5" />
            <line x1="1.2" y1="12" x2="3.4" y2="12" />
            <line x1="20.6" y1="12" x2="22.8" y2="12" />
            <line x1="3.5" y1="20.5" x2="5.1" y2="18.9" />
            <line x1="18.9" y1="5.1" x2="20.5" y2="3.5" />
          </g>
        </svg>
      </span>
    </button>
  );
}
