'use client';

// Shared "reveal a secret" flow for the console. A reveal needs a fresh
// password + TOTP re-auth on top of the session; the first success mints a
// short-lived grant (held in memory only) so further reveals within ~2 minutes
// skip the prompt. The actual secret value is returned to the caller, shown
// masked behind an eye toggle, and never persisted.

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Eye, Lock, X } from 'lucide-react';
import styles from './reveal.module.css';

type RevealFn = (endpoint: string, payload: Record<string, unknown>) => Promise<string | null>;

const Ctx = createContext<RevealFn | null>(null);

export function useReveal(): RevealFn {
  const fn = useContext(Ctx);
  if (!fn) throw new Error('useReveal must be used within RevealProvider');
  return fn;
}

interface Pending {
  endpoint: string;
  payload: Record<string, unknown>;
  resolve: (v: string | null) => void;
}

const TWO_FACTOR_HINT = true; // the prompt asks for a code; server ignores it if 2FA is off

export function RevealProvider({
  twoFactor,
  children,
}: {
  twoFactor: boolean;
  children: React.ReactNode;
}) {
  const grant = useRef<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(
    async (endpoint: string, payload: Record<string, unknown>) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        value?: string;
        grant?: string;
        error?: string;
      };
      return { status: res.status, body };
    },
    [],
  );

  const reveal = useCallback<RevealFn>(
    async (endpoint, payload) => {
      // Try the cached grant first.
      if (grant.current) {
        const { status, body } = await post(endpoint, { ...payload, grant: grant.current });
        if (status === 200 && typeof body.value === 'string') {
          if (body.grant) grant.current = body.grant;
          return body.value;
        }
        grant.current = null; // expired/invalid — fall through to prompt
      }
      // Prompt for re-auth.
      return new Promise<string | null>((resolve) => {
        setPassword('');
        setCode('');
        setError(null);
        setPending({ endpoint, payload, resolve });
      });
    },
    [post],
  );

  const submit = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    const { status, body } = await post(pending.endpoint, {
      ...pending.payload,
      password,
      code,
    });
    setBusy(false);
    if (status === 200 && typeof body.value === 'string') {
      if (body.grant) grant.current = body.grant;
      pending.resolve(body.value);
      setPending(null);
      return;
    }
    setError(body.error ?? 'Could not verify. Try again.');
    setCode('');
  };

  const cancel = () => {
    pending?.resolve(null);
    setPending(null);
  };

  return (
    <Ctx.Provider value={reveal}>
      {children}
      {pending ? (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Re-authenticate">
          <button type="button" className={styles.scrim} onClick={cancel} aria-label="Cancel" />
          <form
            className={styles.dialog}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className={styles.dialogHead}>
              <span className={styles.dialogTitle}>
                <Lock size={15} strokeWidth={2.2} aria-hidden /> Confirm it&apos;s you
              </span>
              <button type="button" className={styles.closeBtn} onClick={cancel} aria-label="Cancel">
                <X size={16} strokeWidth={2.2} aria-hidden />
              </button>
            </div>
            <p className={styles.dialogSub}>
              Re-enter your password{twoFactor && TWO_FACTOR_HINT ? ' and authenticator code' : ''} to
              reveal a stored secret.
            </p>
            <input
              type="password"
              className={styles.field}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Dashboard password"
              autoComplete="current-password"
              autoFocus
              aria-label="Password"
            />
            {twoFactor ? (
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                className={`${styles.field} mono`}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="6-digit code"
                autoComplete="one-time-code"
                aria-label="Authenticator code"
              />
            ) : null}
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <button type="button" className={styles.cancelBtn} onClick={cancel}>
                Cancel
              </button>
              <button
                type="submit"
                className={styles.revealBtn}
                disabled={busy || !password || (twoFactor && code.length !== 6)}
              >
                <Eye size={14} strokeWidth={2.2} aria-hidden /> {busy ? 'Verifying…' : 'Reveal'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </Ctx.Provider>
  );
}
