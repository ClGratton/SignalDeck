'use client';

import { useEffect } from 'react';

/**
 * <html> ships with `.first-load` so the hero intro (and only the hero intro)
 * plays on a real page load. Once it has run, drop the class — from then on,
 * client navigations back to the landing skip the long entrance.
 */
export function FirstLoadReset() {
  useEffect(() => {
    const root = document.documentElement;
    const clear = () => root.classList.remove('first-load');
    // The staggered boot finishes by ~1.6s; clear just after.
    const t = window.setTimeout(clear, 1700);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}
