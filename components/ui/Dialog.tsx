'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import s from './dialog.module.css';
import { cx } from './cx';
import { Button } from './Button';
import { IconButton } from './IconButton';

/*
 * Shared Dialog / Drawer. One implementation of the modal keyboard model:
 *  - Escape closes the TOPMOST dialog only (stack), Tab/Shift+Tab are trapped,
 *  - focus moves in on open and returns to the opener (or `returnFocus()`),
 *  - body scroll is locked (ref-counted so nested dialogs work),
 *  - enter/exit motion (reduced motion = instant), 100dvh + safe-area insets,
 *  - rendered in a portal on <body> so it layers above the global brand pill.
 * `variant="sheet"` is the right-hand drawer (full screen under 640px).
 */

const EXIT_MS = 170;
const stack: symbol[] = [];
let locks = 0;
let savedOverflow = '';

const TABBABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

const prefersReduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export type DialogProps = {
  open: boolean;
  /** Called for Escape, scrim click and the close button. Parent decides (e.g. unsaved-changes confirm). */
  onClose: () => void;
  title: string;
  description?: string;
  variant?: 'modal' | 'sheet';
  /** Modal width: sm 24rem (default), md 32rem. */
  size?: 'sm' | 'md';
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Where focus goes on close when the opener no longer exists (e.g. a closed menu item). */
  returnFocus?: () => HTMLElement | null;
  /** false = Escape/scrim ignored (busy states). */
  dismissible?: boolean;
  /** Extra class on the panel. */
  className?: string;
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  variant = 'modal',
  size = 'sm',
  children,
  footer,
  returnFocus,
  dismissible = true,
  className,
}: DialogProps) {
  const [prevOpen, setPrevOpen] = useState(open);
  const [exiting, setExiting] = useState(false);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setExiting(!open && !prefersReduced());
  }
  useEffect(() => {
    if (!exiting) return;
    const t = window.setTimeout(() => setExiting(false), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [exiting]);

  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissRef = useRef(dismissible);
  const returnRef = useRef(returnFocus);
  onCloseRef.current = onClose;
  dismissRef.current = dismissible;
  returnRef.current = returnFocus;
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const id = Symbol('dialog');
    const opener = document.activeElement as HTMLElement | null;
    stack.push(id);
    if (locks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) {
      const first =
        el.querySelector<HTMLElement>('[data-autofocus]') ??
        el.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]),select,textarea') ??
        el;
      first.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (dismissRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(TABBABLE)].filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      if (--locks === 0) document.body.style.overflow = savedOverflow;
      const target = returnRef.current?.() ?? opener;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open && !exiting) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className={cx(s.root, s[variant])} data-state={open ? 'open' : 'closed'}>
      <div className={s.scrim} onClick={dismissible ? onClose : undefined} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(s.panel, size === 'md' && s.md, className)}
      >
        <header className={s.head}>
          <h2 id={titleId} className={s.title}>
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose} disabled={!dismissible}>
            <X size={18} strokeWidth={2.2} aria-hidden />
          </IconButton>
        </header>
        {description ? (
          <p id={descId} className={s.desc}>
            {description}
          </p>
        ) : null}
        <div className={s.body}>{children}</div>
        {footer ? <footer className={s.foot}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Small confirm modal. Use `formAction` when the confirm must submit a server action. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  busy,
  onConfirm,
  formAction,
  onCancel,
  returnFocus,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm?: () => void;
  formAction?: (formData: FormData) => void | Promise<void>;
  onCancel: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const btn = (
    <Button
      type={formAction ? 'submit' : 'button'}
      variant={danger ? 'danger' : 'primary'}
      loading={busy}
      onClick={formAction ? undefined : onConfirm}
    >
      {confirmLabel}
    </Button>
  );
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={message}
      returnFocus={returnFocus}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          {formAction ? <form action={formAction}>{btn}</form> : btn}
        </>
      }
    >
      {null}
    </Dialog>
  );
}
