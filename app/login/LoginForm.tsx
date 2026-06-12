'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check } from 'lucide-react';
import { signIn, type SignInState } from './actions';
import styles from './login.module.css';

const initial: SignInState = {};

export function LoginForm({ from, twoFactor }: { from: string; twoFactor: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(signIn, initial);
  const [step, setStep] = useState<'password' | 'code'>('password');
  // Controlled values: React resets uncontrolled form fields after a server
  // action responds, which would silently wipe the (hidden) password after a
  // failed attempt and make every retry from the code step unwinnable.
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const pwRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  // Move from password to code. PURE component state — never touch the history
  // stack (no pushState/back choreography; it races Next's router and created a
  // dashboard⇄login back-trap). /login is always exactly one history entry.
  // Password is NOT checked here — both factors are verified together on
  // submit, so a correct password is never confirmed before the code.
  const advance = () => {
    if (!password) {
      pwRef.current?.focus();
      return;
    }
    setStep('code');
  };

  // The corner brand control dispatches a cancelable 'grtlabs:back' before it
  // navigates. On the code step we claim it: back means "back to the password
  // panel", not "leave the page".
  useEffect(() => {
    const onBack = (e: Event) => {
      if (step === 'code') {
        e.preventDefault();
        setStep('password');
      }
    };
    window.addEventListener('grtlabs:back', onBack);
    return () => window.removeEventListener('grtlabs:back', onBack);
  }, [step]);

  // Success: the server has set the session cookie; finish with replace() so
  // /login is swapped out of history for the console — Back from the console
  // then returns to wherever you came from (the landing page), never the form.
  useEffect(() => {
    if (state.ok && state.dest) router.replace(state.dest);
  }, [state, router]);

  // Keep focus on the field that's in view as the panels slide.
  useEffect(() => {
    const target = step === 'code' ? codeRef.current : pwRef.current;
    const id = requestAnimationFrame(() => target?.focus());
    return () => cancelAnimationFrame(id);
  }, [step]);

  const errorEl = state.error ? (
    <p id="login-error" className={styles.error} role="alert">
      {state.error}
    </p>
  ) : null;

  // Single-factor fallback when no TOTP secret is configured.
  if (!twoFactor) {
    return (
      <form action={action} className={styles.form}>
        <input type="hidden" name="from" value={from} />
        <label className={`${styles.label} mono`} htmlFor="password">
          dashboard password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          className={styles.input}
          placeholder="••••••••••"
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? 'login-error' : undefined}
        />
        {errorEl}
        <button type="submit" className={styles.submit} disabled={pending || state.ok}>
          {state.ok ? (
            <>
              <Check size={17} strokeWidth={2.4} aria-hidden />
              <span>Authenticated</span>
            </>
          ) : (
            <>
              <span>{pending ? 'Checking…' : 'Enter console'}</span>
              <ArrowRight size={17} strokeWidth={2.2} aria-hidden />
            </>
          )}
        </button>
      </form>
    );
  }

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="from" value={from} />
      <div className={styles.steps} data-step={step}>
        <div className={styles.track}>
          {/* Step 1 — password */}
          <div className={styles.step} inert={step !== 'password'}>
            <label className={`${styles.label} mono`} htmlFor="password">
              dashboard password
            </label>
            <input
              ref={pwRef}
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              className={styles.input}
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  advance();
                }
              }}
            />
            <button type="button" className={styles.submit} onClick={advance}>
              <span>Continue</span>
              <ArrowRight size={17} strokeWidth={2.2} aria-hidden />
            </button>
          </div>

          {/* Step 2 — authenticator code */}
          <div className={styles.step} inert={step !== 'code'}>
            <label className={`${styles.label} mono`} htmlFor="code">
              authentication code
            </label>
            <input
              ref={codeRef}
              id="code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              className={`${styles.input} ${styles.code} mono tnum`}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              aria-invalid={Boolean(state.error)}
              aria-describedby={state.error ? 'login-error' : undefined}
            />
            {errorEl}
            <button type="submit" className={styles.submit} disabled={pending || state.ok}>
              {state.ok ? (
                <>
                  <Check size={17} strokeWidth={2.4} aria-hidden />
                  <span>Authenticated</span>
                </>
              ) : (
                <>
                  <span>{pending ? 'Verifying…' : 'Enter console'}</span>
                  <ArrowRight size={17} strokeWidth={2.2} aria-hidden />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
