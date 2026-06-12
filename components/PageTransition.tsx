'use client';

import { useRef } from 'react';
import { usePathname } from 'next/navigation';
import styles from './PageTransition.module.css';

/**
 * Keys the page content on the pathname so each route change replays a short
 * fade-and-rise. The animated background + the BrandNav live OUTSIDE this wrapper
 * (siblings in the layout), so they persist across navigation — the scene stays
 * coherent while only the foreground content transitions in.
 *
 * The fade is applied ONLY to elements created by a client navigation
 * (data-animate), never to the initial load. Do not gate it on a class that is
 * later removed (html.first-load): an animation starts the moment its rule first
 * matches, so removing the class seconds after load made the whole page blink.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const initialPath = useRef<string | null>(pathname);
  // Once the path changes we're past the initial load for good (even if the
  // user navigates back to the original path, that's still a client nav).
  if (initialPath.current !== null && initialPath.current !== pathname) {
    initialPath.current = null;
  }
  const navigated = initialPath.current === null;
  return (
    <div key={pathname} className={styles.route} data-animate={navigated ? true : undefined}>
      {children}
    </div>
  );
}
