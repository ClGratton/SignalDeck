'use client';

// Header account / overflow menu. Desktop: the account menu (sign out, sign out
// everywhere). Phone (<=640px): the single overflow menu that also carries
// Edit dashboard and Settings, so the bar holds only brand, title, theme, menu.

import { useEffect, useRef, useState } from 'react';
import { CircleUser, Ellipsis, LayoutGrid, LogOut, Settings, ShieldOff, Check } from 'lucide-react';
import { signOut } from '@/app/dashboard/actions';
import { IconButton } from '@/components/ui/IconButton';
import styles from './console.module.css';

export function AccountMenu({
  triggerRef,
  editing,
  onEdit,
  onSettings,
  onSignOutEverywhere,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  editing: boolean;
  onEdit: () => void;
  onSettings: () => void;
  onSignOutEverywhere: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-mobile-only]), [role="menuitem"]')?.focus();
    const items = () =>
      [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].filter((n) => n.offsetParent !== null);
    // Focus the first VISIBLE item (mobile-only items are display:none on desktop).
    items()[0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const n = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[n]?.focus();
      } else if (e.key === 'Tab') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className={styles.menuWrap} ref={wrap}>
      <IconButton
        ref={triggerRef}
        variant="secondary"
        label="Account and more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis size={18} strokeWidth={2.2} aria-hidden className={styles.onlyMobile} />
        <CircleUser size={18} strokeWidth={2.2} aria-hidden className={styles.onlyDesktop} />
      </IconButton>
      {open ? (
        <div className={`${styles.menu} pop`} role="menu" aria-label="Account" ref={menu}>
          <button type="button" role="menuitem" data-mobile-only className={styles.menuItem} onClick={pick(onEdit)}>
            {editing ? <Check size={16} strokeWidth={2.2} aria-hidden /> : <LayoutGrid size={16} strokeWidth={2.2} aria-hidden />}
            {editing ? 'Done editing' : 'Edit dashboard'}
          </button>
          <button type="button" role="menuitem" data-mobile-only className={styles.menuItem} onClick={pick(onSettings)}>
            <Settings size={16} strokeWidth={2.2} aria-hidden /> Settings
          </button>
          <hr className={styles.menuSep} data-mobile-only />
          <form action={signOut}>
            <button type="submit" role="menuitem" className={styles.menuItem}>
              <LogOut size={16} strokeWidth={2.2} aria-hidden /> Sign out
            </button>
          </form>
          <button type="button" role="menuitem" className={`${styles.menuItem} ${styles.menuDanger}`} onClick={pick(onSignOutEverywhere)}>
            <ShieldOff size={16} strokeWidth={2.2} aria-hidden /> Sign out everywhere
          </button>
        </div>
      ) : null}
    </div>
  );
}
