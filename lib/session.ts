import { cookies } from 'next/headers';
import { SESSION_COOKIE, parseSessionToken, sessionIdOf } from '@/lib/auth';
import { getAuthEpoch } from '@/lib/auth-store';
import { validateSession } from '@/lib/session-store';

/** Read and verify the session: signature + epoch + the session registry (which
 *  enforces the idle/absolute timeouts and refreshes activity on each call). */
export async function hasValidSession(): Promise<boolean> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const parsed = await parseSessionToken(token, secret, getAuthEpoch());
  if (!parsed) return false;
  return validateSession(parsed.sessionId);
}

/** The current request's session id (from the already-validated cookie), for
 *  tagging "this device" in the session list and binding the QR handoff. */
export async function currentSessionId(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return sessionIdOf(token);
}
