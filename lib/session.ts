import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth';
import { getAuthEpoch } from '@/lib/auth-store';

/** Read and verify the session in a server component. */
export async function hasValidSession(): Promise<boolean> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySessionToken(token, secret, getAuthEpoch());
}
