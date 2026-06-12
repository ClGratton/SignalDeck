'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { lab } from '@/lib/config';
import styles from './BrandNav.module.css';

/**
 * Persistent top-corner control, mounted once in the root layout so it survives
 * route changes. On `/` it's the Grtlabs wordmark; on any inner page the label
 * stays put and the pulse glyph morphs into a back arrow inside a fading-in
 * bubble. The app's universal back.
 *
 * On `/login`, ON MOBILE ONLY, it relocates into the login card: it fades out at
 * the corner, fades back in as the plain logo inside the card's reserved slot,
 * then runs the usual morph (bubble + glyph → arrow). No gliding across the
 * screen — it disappears and reappears. On desktop it stays in the corner.
 */
export function BrandNav() {
  const pathname = usePathname();
  const router = useRouter();
  const isHome = pathname === '/';
  const isLogin = pathname === '/login';

  const [dock, setDock] = useState<{ x: number; y: number } | null>(null);
  const [dim, setDim] = useState(false); // opacity fade for the relocation
  const [asLogo, setAsLogo] = useState(false); // hold the plain logo (suppress morph) briefly

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 960px)').matches;

    if (!(isLogin && isMobile)) {
      // Desktop, or any non-login page: live in the corner, morph handled by CSS.
      setDock(null);
      setDim(false);
      setAsLogo(false);
      return;
    }

    // Mobile + login: disappear from the corner, reappear as the logo inside the
    // card, then morph into the back arrow + bubble.
    setAsLogo(true); // plain logo while it moves
    setDim(true); // fade out at the corner
    const timers: number[] = [];
    timers.push(
      window.setTimeout(() => {
        const slot = document.querySelector('[data-brand-dock]');
        if (slot) {
          const r = slot.getBoundingClientRect();
          setDock({ x: Math.round(r.left), y: Math.round(r.top) });
        }
        requestAnimationFrame(() => setDim(false)); // reappear at the card (still plain)
        timers.push(window.setTimeout(() => setAsLogo(false), 260)); // then morph
      }, 180),
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [pathname, isLogin]);

  const goBack = () => {
    if (isHome) return;
    // Let the current page claim the back action first — the login form's code
    // step returns to its password panel instead of leaving the page.
    // dispatchEvent returns false when a listener called preventDefault().
    const proceed = window.dispatchEvent(new CustomEvent('grtlabs:back', { cancelable: true }));
    if (!proceed) return;
    // "Back to Grtlabs" means home — deterministic, unlike history.back(),
    // which can leave the site or land on a stale entry.
    router.push('/');
  };

  return (
    <button
      type="button"
      className={styles.brand}
      data-home={isHome}
      data-logo={asLogo ? true : undefined}
      data-dim={dim ? true : undefined}
      style={dock ? { top: `${dock.y}px`, left: `${dock.x}px` } : undefined}
      onClick={goBack}
      aria-label={isHome ? lab.name : `Back to ${lab.name}`}
      aria-disabled={isHome}
    >
      <svg className={styles.glyph} viewBox="0 0 32 18" fill="none" aria-hidden>
        <path
          className={styles.glyphPath}
          d="M1 9 L9 9 L12 2 L13 5.5 L13.5 7.25 L14 9 L16 16 L19.5 6 L22 9 L31 9"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className={styles.label}>{lab.name}</span>
    </button>
  );
}
