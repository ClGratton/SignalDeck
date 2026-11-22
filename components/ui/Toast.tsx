'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import s from './ui.module.css';
import { cx } from './cx';

type Kind = 'success' | 'error' | 'info';
type Item = { id: number; kind: Kind; message: string };
type Push = (message: string, kind?: Kind) => void;

const Ctx = createContext<Push>(() => {});
export const useToast = () => useContext(Ctx);

/** Live region per toast: role=status (polite), errors role=alert. Auto-dismiss 4s (7s errors). */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const n = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((l) => l.filter((t) => t.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const push = useCallback<Push>(
    (message, kind = 'info') => {
      const id = ++n.current;
      setItems((l) => [...l.slice(-3), { id, kind, message }]);
      timers.current.set(id, setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4000));
    },
    [dismiss],
  );

  useEffect(() => {
    const m = timers.current;
    return () => m.forEach(clearTimeout);
  }, []);

  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className={s.toasts}>
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className={cx(s.toast, s[`toast-${t.kind}`], 'enter')}
          >
            <span className={s.toastMsg}>{t.message}</span>
            <button
              type="button"
              className={cx(s.btn, s.ghost, s.icon)}
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
