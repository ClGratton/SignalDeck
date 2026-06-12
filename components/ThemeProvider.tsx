'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { DEFAULT_THEME, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// How long the page-wide color crossfade runs; matches --dur-slow + a little slack.
const TRANSITION_MS = 480;
let transitionTimer: ReturnType<typeof setTimeout> | undefined;

function apply(t: Theme) {
  const d = document.documentElement;
  d.dataset.theme = t;
  d.style.colorScheme = t;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    /* storage unavailable; theme still applies for the session */
  }
}

// Toggle a brief class that lets the whole page crossfade its colors instead of
// snapping. Skipped entirely under reduced motion (the snap is the accessible path).
function applyAnimated(t: Theme) {
  const reduce =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    apply(t);
    return;
  }
  const d = document.documentElement;
  d.classList.add('theme-changing');
  apply(t);
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => d.classList.remove('theme-changing'), TRANSITION_MS);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  // Adopt whatever the pre-paint inline script resolved (storage / default).
  useEffect(() => {
    const attr = document.documentElement.dataset.theme;
    if (attr === 'light' || attr === 'dark') setThemeState(attr);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    applyAnimated(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      applyAnimated(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
