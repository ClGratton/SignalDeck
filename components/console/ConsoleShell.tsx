'use client';

// The operator console: header, live panel grid, collapsible assistant sidebar.
// Polls the privileged /api/console snapshot; the page passes whatever the
// server had cached so first paint is instant.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, PanelRightOpen, Settings, LayoutGrid, Check, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { AccountMenu } from './AccountMenu';
import type { ConsoleSnapshot } from '@/lib/console';
import type { AssistantProvider } from '@/lib/assistant/types';
import { signOutEverywhere } from '@/app/dashboard/actions';
import { ThemeToggle } from '@/components/ThemeToggle';
import { RevealProvider } from './RevealProvider';
import { SettingsPanel } from './SettingsPanel';
import { DashboardGrid } from './DashboardGrid';
import { DashboardDataProvider } from './widgets';
import { DEFAULT_LAYOUT, type DashboardLayout } from '@/lib/dashboard/types';
import { AssistantSidebar } from './AssistantSidebar';
import styles from './console.module.css';

const POLL_MS = 12_000;

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
const SIDEBAR_KEY = 'grtlabs:assistant-open';

export function ConsoleShell({
  initial,
  assistantProvider,
  twoFactor,
}: {
  initial: ConsoleSnapshot | null;
  assistantProvider: AssistantProvider | null;
  twoFactor: boolean;
}) {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(initial);
  const [stale, setStale] = useState(false);
  // The tile layout: render the default instantly, then hydrate from the server
  // (shared across devices, persisted) — same first-paint discipline as the rest.
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_LAYOUT);
  const [editing, setEditing] = useState(false);
  const layoutSaveTimer = useRef<number | null>(null);
  // Apply a layout edit locally at once, then debounce-persist it to the server
  // (the source of truth across devices).
  const saveLayout = useCallback((next: DashboardLayout) => {
    setLayout(next);
    if (layoutSaveTimer.current) window.clearTimeout(layoutSaveTimer.current);
    layoutSaveTimer.current = window.setTimeout(() => {
      void fetch('/api/dashboard/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: next }),
      }).catch(() => undefined);
    }, 500);
  }, []);
  // Desktop: sidebar docked in the grid, collapse remembered. Mobile: overlay.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmEverywhere, setConfirmEverywhere] = useState(false);
  const [lastOk, setLastOk] = useState<number | null>(initial ? Date.now() : null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const fails = useRef(0);
  const settingsBtn = useRef<HTMLButtonElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  // Return focus to whichever control opened a dialog: the overflow menu on phones, the settings button otherwise.
  const openerOnPhone = () => window.matchMedia('(max-width: 640px)').matches;
  const settingsReturn = () => (openerOnPhone() ? menuBtn.current : settingsBtn.current);

  useEffect(() => {
    const saved = window.localStorage.getItem(SIDEBAR_KEY);
    if (saved != null) {
      const savedOpen = saved === '1';
      setSidebarOpen(savedOpen);
    }
  }, []);

  // Pull the saved tile layout once on mount (falls back to the default already
  // on screen if it's never been customized or the request fails).
  useEffect(() => {
    let alive = true;
    fetch('/api/dashboard/layout', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { layout?: DashboardLayout } | null) => {
        if (alive && d?.layout) setLayout(d.layout);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/console', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setSnapshot((await res.json()) as ConsoleSnapshot);
      fails.current = 0;
      setLastOk(Date.now());
      setStale(false);
    } catch {
      // Keep showing the last snapshot; only flag offline after two failures in a row (ES5).
      fails.current += 1;
      if (fails.current >= 2) {
        setNowTick(Date.now());
        setStale(true);
      }
    }
  }, []);

  useEffect(() => {
    void poll();
    const tick = () => {
      timer.current = window.setTimeout(async () => {
        if (document.visibilityState === 'visible') await poll();
        tick();
      }, POLL_MS);
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  const toggleSidebar = useCallback((open: boolean) => {
    setSidebarOpen(open);
    window.localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0');
  }, []);

  const handleBrowserVisibleChange = useCallback((visible: boolean) => {
    setBrowserVisible(visible);
    if (!visible) return;
    if (window.matchMedia('(max-width: 1100px)').matches) setDrawerOpen(true);
    else toggleSidebar(true);
  }, [toggleSidebar]);

  // The mobile drawer lives inside this page's stacking context, so it cannot
  // layer above the global BrandNav pill — hide the pill while the drawer is
  // open instead (global rule in globals.css keyed on this attribute).
  useEffect(() => {
    document.documentElement.toggleAttribute('data-assistant-drawer', drawerOpen);
    return () => document.documentElement.removeAttribute('data-assistant-drawer');
  }, [drawerOpen]);

  const loading = snapshot == null;

  return (
    <RevealProvider twoFactor={twoFactor}>
    <div className={styles.wrap} data-sidebar={sidebarOpen || undefined}>
      <header className={styles.bar}>
        {/* The persistent BrandNav pill floats at the top-left corner and IS the
            brand here (and the way back home) — the bar adds the page title and
            live connection state after it, offset to clear the pill. */}
        <span className={styles.barLeft}>
          <h1 className={styles.title}>Console</h1>
          <span className={`${styles.conn} mono`} data-state={stale ? 'stale' : 'live'} role="status">
            <span className={styles.connDot} aria-hidden />
            {stale ? 'offline' : 'live'}
          </span>
        </span>
        <div className={styles.barRight}>
          <ThemeToggle />
          {/* Desktop-only direct actions; on phones they live in the overflow menu. */}
          <span className={styles.desktopActions}>
            {editing ? (
              <Button variant="primary" onClick={() => setEditing(false)}>
                <Check size={16} strokeWidth={2.4} aria-hidden /> Done
              </Button>
            ) : (
              <IconButton variant="secondary" label="Edit dashboard layout" onClick={() => setEditing(true)}>
                <LayoutGrid size={16} strokeWidth={2.2} aria-hidden />
              </IconButton>
            )}
            <IconButton
              ref={settingsBtn}
              variant="secondary"
              label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={16} strokeWidth={2.2} aria-hidden />
            </IconButton>
          </span>
          <AccountMenu
            triggerRef={menuBtn}
            editing={editing}
            onEdit={() => setEditing((v) => !v)}
            onSettings={() => setSettingsOpen(true)}
            onSignOutEverywhere={() => setConfirmEverywhere(true)}
          />
          {!sidebarOpen ? (
            <button
              type="button"
              className={styles.assistantOpen}
              onClick={() => toggleSidebar(true)}
              aria-label="Show assistant"
            >
              <PanelRightOpen size={16} strokeWidth={2.2} aria-hidden />
              <span>Operator</span>
            </button>
          ) : null}
        </div>
      </header>

      {stale ? (
        <div className={`${styles.offlineBanner} enter`} role="status">
          <WifiOff size={16} strokeWidth={2.2} aria-hidden />
          <span>
            Lost contact with the dashboard server
            {lastOk ? ` — showing data from ${ago(lastOk, nowTick)}` : ''}. Retrying automatically.
          </span>
          <Button variant="secondary" onClick={() => void poll()}>
            Retry now
          </Button>
        </div>
      ) : null}
      <p className={styles.srOnly} aria-live="polite">
        {editing ? 'Editing dashboard layout. Use Done to finish.' : ''}
      </p>

      <div className={styles.body}>
        <main className={styles.gridArea} aria-label="Homelab dashboard">
          <DashboardDataProvider value={{ snapshot, loading, stale, lastOk, retry: poll }}>
            <DashboardGrid layout={layout} editing={editing} onChange={saveLayout} />
          </DashboardDataProvider>
        </main>

        <div className={styles.sidebarSlot}>
          <AssistantSidebar
            provider={assistantProvider}
            open={drawerOpen}
            browserVisible={browserVisible}
            onBrowserVisibleChange={handleBrowserVisibleChange}
            onClose={() => {
              setBrowserVisible(false);
              // Mobile closes the drawer; desktop collapses (and remembers it).
              if (window.matchMedia('(max-width: 1100px)').matches) setDrawerOpen(false);
              else toggleSidebar(false);
            }}
          />
        </div>
      </div>

      {/* Mobile: floating assistant button + scrim for the drawer */}
      <button
        type="button"
        className={styles.fab}
        onClick={() => setDrawerOpen(true)}
        aria-label="Open assistant"
      >
        <Bot size={20} strokeWidth={2.2} aria-hidden />
      </button>
      {drawerOpen ? (
        <button
          type="button"
          className={styles.scrim}
          onClick={() => setDrawerOpen(false)}
          aria-label="Close assistant"
        />
      ) : null}

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} returnFocus={settingsReturn} />
      <ConfirmDialog
        open={confirmEverywhere}
        title="Sign out everywhere?"
        message="Every session on every device is invalidated, including this one. You will need your password and code to sign in again."
        confirmLabel="Sign out everywhere"
        danger
        formAction={signOutEverywhere}
        onCancel={() => setConfirmEverywhere(false)}
        returnFocus={() => menuBtn.current}
      />
    </div>
    </RevealProvider>
  );
}
