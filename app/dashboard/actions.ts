'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, sessionIdOf } from '@/lib/auth';
import { bumpAuthEpoch } from '@/lib/auth-store';
import { revokeSession, clearSessions } from '@/lib/session-store';

export async function signOut() {
  const jar = await cookies();
  const id = sessionIdOf(jar.get(SESSION_COOKIE)?.value);
  if (id) revokeSession(id); // drop just this device from the registry
  jar.delete(SESSION_COOKIE);
  redirect('/');
}

/**
 * Sign out EVERYWHERE: bumps the auth epoch (instantly invalidating every
 * outstanding token on every device, this one included) AND wipes the session
 * registry. The kill switch for a lost device or a suspected stolen cookie.
 */
export async function signOutEverywhere() {
  bumpAuthEpoch();
  clearSessions();
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/');
}
