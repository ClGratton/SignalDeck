import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth';
import { getAuthEpoch } from '@/lib/auth-store';

// Guards every dashboard route. Unauthenticated requests are bounced to /login
// with a `from` hint so sign-in can return the user to where they were headed.
// Runs on the Node runtime (not Edge) so it can read the persisted auth epoch —
// that's what makes "sign out everywhere" enforceable at the door.
export async function middleware(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const authed = secret ? await verifySessionToken(token, secret, getAuthEpoch()) : false;

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
