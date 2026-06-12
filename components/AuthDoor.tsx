'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CornerDownLeft } from 'lucide-react';
import styles from './AuthDoor.module.css';

const INTERACTIVE = new Set(['input', 'textarea', 'button', 'a', 'select']);

export function AuthDoor({ href, label }: { href: string; label: string }) {
  const router = useRouter();

  // Keyboard affordance: Enter opens the door when nothing else is focused.
  useEffect(() => {
    router.prefetch(href);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (INTERACTIVE.has(tag)) return;
      e.preventDefault();
      router.push(href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [href, router]);

  return (
    <div className={styles.door}>
      <Link href={href} className={styles.button}>
        <span>{label}</span>
        <ArrowRight size={17} strokeWidth={2.2} aria-hidden />
      </Link>
      <span className={`${styles.hint} mono`} aria-hidden>
        press
        <kbd className={styles.kbd}>
          <CornerDownLeft size={11} strokeWidth={2.4} /> Enter
        </kbd>
      </span>
    </div>
  );
}
