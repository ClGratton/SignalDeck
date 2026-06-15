import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, parseSessionToken } from '@/lib/auth';
import { getAuthEpoch } from '@/lib/auth-store';

// Guards every dashboard route. Unauthenticated requests are bounced to /login
// with a `from` hint so sign-in can return the user to where they were headed.
// Runs on the Node runtime (not Edge) so it can read the persisted auth epoch —
// that's what makes "sign out everywhere" enforceable at the door.
export async function middleware(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  // Middleware stays lean + edge-safe: it only verifies the token (signature +
  // epoch + hard cap) at the door. The session REGISTRY (idle/absolute timeouts,
  // concurrent eviction) is enforced by hasValidSession() on the Node side — the
  // dashboard page and every privileged route call it, so an idle-expired or
  // evicted session is bounced there (and the registry can't pull node:fs into
  // the middleware bundle).
  const parsed = secret ? await parseSessionToken(token, secret, getAuthEpoch()) : null;
  const authed = parsed != null;

  if (!authed) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('from', req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*'],
  runtime: 'nodejs',
};
