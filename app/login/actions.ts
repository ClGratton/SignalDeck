'use server';

import { cookies, headers } from 'next/headers';
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from '@/lib/auth';
import { getAuthEpoch, getLastTotpStep, setLastTotpStep } from '@/lib/auth-store';
import { checkThrottle, recordFailure, recordSuccess } from '@/lib/login-throttle';
import { verifyTotp } from '@/lib/totp';

export interface SignInState {
  error?: string;
  /** Set on success; the client finishes the navigation with router.replace()
   *  so the login page doesn't linger in the history stack. */
  ok?: boolean;
  dest?: string;
}

function safeDestination(from: unknown): string {
  const value = typeof from === 'string' ? from : '';
  // Internal paths only — reject protocol-relative and absolute URLs.
  return value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

/** Constant-time string compare so password checking can't be timed. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Best-effort client IP for throttling. Behind Cloudflare the first header is
 *  authoritative; locally it falls back to a constant (still throttled). */
async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('cf-connecting-ip') ??
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'local'
  );
}

export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const password = String(formData.get('password') ?? '');
  const code = String(formData.get('code') ?? '');
  const dest = safeDestination(formData.get('from'));

  const secret = process.env.AUTH_SECRET;
  const expected = process.env.DASHBOARD_PASSWORD;
  const totpSecret = process.env.TWO_FACTOR_SECRET;

  if (!secret || !expected) {
    return {
      error: 'Sign-in is not configured. Set AUTH_SECRET and DASHBOARD_PASSWORD in .env.local.',
    };
  }

  // Brute-force gate FIRST, before any credential work.
  const ip = await clientIp();
  const waitSeconds = checkThrottle(ip);
  if (waitSeconds != null) {
    return { error: `Too many attempts. Try again in ${waitSeconds}s.` };
  }

  // Prompt for any missing field before checking credentials.
  if (!password) return { error: 'Enter the dashboard password.' };
  if (totpSecret && !code) return { error: 'Enter your 6-digit authentication code.' };

  // Evaluate both factors, then fail with ONE generic message so a correct
  // password is never confirmed to someone who lacks the code (and vice versa).
  const passwordOk = timingSafeEqual(password, expected);
  const matchedStep = totpSecret ? await verifyTotp(code, totpSecret) : null;
  const codeOk = totpSecret ? matchedStep !== null && matchedStep > getLastTotpStep() : true;

  if (!passwordOk || !codeOk) {
    recordFailure(ip);
    return { error: 'Incorrect password or authentication code.' };
  }

  // Burn the matched step (persisted) so the same code can't be replayed, even
  // across a server restart.
  if (totpSecret && matchedStep !== null) setLastTotpStep(matchedStep);
  recordSuccess(ip);

  const token = await createSessionToken(secret, getAuthEpoch());
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions);
  // No server redirect: the form replaces /login (and the code step's pushed
  // history entry) client-side, so Back from the console returns to the landing
  // page instead of stepping through the sign-in form again.
  return { ok: true, dest };
}
