'use client';

// Mobile side of the QR cross-device sign-in. The desktop shows a QR pointing
// here with the single-use handoff token in the URL FRAGMENT (#…) — which never
// reaches the server. This page reads it, asks the server which desktop minted
// it, shows "Sign in from <device>?", and on confirm redeems it for a session.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ThemeToggle } from '@/components/ThemeToggle';
import styles from '../login.module.css';

type Phase = 'loading' | 'confirm' | 'redeeming' | 'invalid' | 'error';

export default function QrSignInPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState('');
  const [sourceLabel, setSourceLabel] = useState('a desktop');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const t = window.location.hash.replace(/^#/, '').trim();
    if (!t) {
      setPhase('invalid');
      return;
    }
    setToken(t);
    void fetch(`/api/auth/handoff/redeem?token=${encodeURIComponent(t)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { valid?: boolean; sourceLabel?: string }) => {
        if (d.valid) {
          setSourceLabel(d.sourceLabel || 'a desktop');
          setPhase('confirm');
        } else {
          setPhase('invalid');
        }
      })
      .catch(() => setPhase('error'));
  }, []);

  const confirm = useCallback(async () => {
    setPhase('redeeming');
    setErrorMsg('');
    try {
      const res = await fetch('/api/auth/handoff/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json()) as { ok?: boolean; dest?: string; error?: string };
      if (res.ok && body.ok) {
        // Clear the token from the address bar, then enter the console.
        window.history.replaceState(null, '', '/login/qr');
        router.replace(body.dest && body.dest.startsWith('/') ? body.dest : '/dashboard');
        return;
      }
      setErrorMsg(body.error ?? 'Could not sign in.');
      setPhase('error');
    } catch {
      setErrorMsg('Network error — try again.');
      setPhase('error');
    }
  }, [token, router]);

  return (
    <main className={styles.wrap}>
      <span className={styles.themeSlot}>
        <ThemeToggle />
      </span>
      <div className={styles.card}>
        <span className={styles.brandDock} data-brand-dock aria-hidden />
        <h1 className={styles.title}>Sign in from desktop</h1>

        {phase === 'loading' ? (
          <p className={styles.sub}>Checking the sign-in link…</p>
        ) : phase === 'invalid' ? (
          <p className={styles.sub}>
            This sign-in link has expired or was already used. Show a fresh QR code on the desktop
            and scan it again.
          </p>
        ) : (
          <>
            <p className={styles.sub}>
              Approve signing this device in to the operator console, requested from{' '}
              <strong>{sourceLabel}</strong>.
            </p>
            {phase === 'error' && errorMsg ? (
              <p className={styles.error} role="alert">
                {errorMsg}
              </p>
            ) : null}
            <button
              type="button"
              className={styles.submit}
              onClick={() => void confirm()}
              disabled={phase === 'redeeming'}
            >
              {phase === 'redeeming' ? 'Signing in…' : `Sign in from ${sourceLabel}`}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
