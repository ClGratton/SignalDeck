import { NextResponse, type NextRequest } from 'next/server';
import QRCode from 'qrcode';
import { hasValidSession } from '@/lib/session';
import { mintHandoff } from '@/lib/auth-handoff';
import { deviceLabel } from '@/lib/session-store';

export const runtime = 'nodejs';

/** PRIVILEGED: an authenticated desktop mints a single-use ~60s QR handoff token
 *  bound to its session and gets back a QR (SVG) the phone can scan to sign in.
 *  The token rides in the URL FRAGMENT (#…) so it never reaches a server log. */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const label = deviceLabel(req.headers.get('user-agent'));
  const { token, expiresAt } = mintHandoff(label);

  // Encode the CURRENT origin so the phone reaches the same server (LAN IP or
  // the public domain, whichever the desktop is on). Fragment keeps it off logs.
  const url = `${req.nextUrl.origin}/login/qr#${token}`;
  let qrSvg: string;
  try {
    qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  } catch {
    return NextResponse.json({ error: 'Could not render the QR code.' }, { status: 500 });
  }

  return NextResponse.json(
    { qrSvg, code: token, expiresAt, sourceLabel: label },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
