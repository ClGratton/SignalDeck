'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/auth';
import { bumpAuthEpoch } from '@/lib/auth-store';

export async function signOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/');
}

/**
 * Sign out EVERYWHERE: bumps the auth epoch, instantly invalidating every
 * outstanding session token on every device (this one included). The kill
 * switch for a lost device or a suspected stolen cookie.
 */
export async function signOutEverywhere() {
  bumpAuthEpoch();
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/');
}
