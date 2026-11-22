'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Eye, EyeOff } from 'lucide-react';
import { Button, IconButton } from '@/components/ui';
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
  const [showPw, setShowPw] = useState(false);
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

  // Throttle message ("Try again in 30s.") becomes a live countdown. The server
  // owns the throttle; this only mirrors the number it reported.
  const [wait, setWait] = useState(0);
  useEffect(() => {
    const m = state.error?.match(/Try again in (\d+)s/);
    setWait(m ? Number(m[1]) : 0);
  }, [state]);
  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => window.clearInterval(id);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const throttled = wait > 0;
  const errorText = throttled
    ? `Too many attempts. Try again in ${wait}s.`
    : state.error?.startsWith('Too many attempts')
      ? 'You can try again now.'
      : state.error;

  // The line is always rendered (reserved height), so an error never shifts the layout.
  const errorEl = (
    <p id="login-error" className={styles.error} role="alert">
      {errorText}
    </p>
  );

  const submitBtn = (idle: string, busy: string) => (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      block
      className={styles.submit}
      disabled={pending || state.ok || throttled}
      loading={pending}
    >
      {state.ok ? (
        <>
          <Check size={17} strokeWidth={2.4} aria-hidden /> Authenticated
        </>
      ) : (
        <>
          {pending ? busy : idle}
          {!pending && <ArrowRight size={17} strokeWidth={2.2} aria-hidden />}
        </>
      )}
    </Button>
  );

  const pwInput = (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div className={styles.pwWrap}>
      <input
        id="password"
        name="password"
        type={showPw ? 'text' : 'password'}
        autoComplete="current-password"
        className={`${styles.input} ${styles.pwInput}`}
        placeholder="••••••••••"
        {...props}
      />
      <IconButton
        className={styles.reveal}
        label={showPw ? 'Hide password' : 'Show password'}
        aria-pressed={showPw}
        onClick={() => setShowPw((v) => !v)}
      >
        {showPw ? <EyeOff size={17} aria-hidden /> : <Eye size={17} aria-hidden />}
      </IconButton>
    </div>
  );

  // Single-factor fallback when no TOTP secret is configured.
  if (!twoFactor) {
    return (
      <form action={action} className={styles.form}>
        <input type="hidden" name="from" value={from} />
        <label className={styles.label} htmlFor="password">
          Dashboard password
        </label>
        {pwInput({
          autoFocus: true,
          'aria-invalid': Boolean(state.error),
          'aria-describedby': state.error ? 'login-error' : undefined,
        })}
        {errorEl}
        {submitBtn('Enter console', 'Checking…')}
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
            <label className={styles.label} htmlFor="password">
              Dashboard password
            </label>
            {pwInput({
              ref: pwRef,
              value: password,
              onChange: (e) => setPassword(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  advance();
                }
              },
            } as React.InputHTMLAttributes<HTMLInputElement>)}
            <Button type="button" variant="primary" size="lg" block className={styles.submit} onClick={advance}>
              Continue
              <ArrowRight size={17} strokeWidth={2.2} aria-hidden />
            </Button>
          </div>

          {/* Step 2 — authenticator code */}
          <div className={styles.step} inert={step !== 'code'}>
            <label className={styles.label} htmlFor="code">
              Authentication code
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
            {submitBtn('Enter console', 'Verifying…')}
          </div>
        </div>
      </div>
    </form>
  );
}
