import { NextResponse, type NextRequest } from 'next/server';
import QRCode from 'qrcode';
import { hasValidSession } from '@/lib/session';
import { mintHandoff } from '@/lib/auth-handoff';
import { deviceLabel } from '@/lib/session-store';

export const runtime = 'nodejs';

/** The PUBLIC origin the phone should hit — the host the operator is actually on.
 *  Behind a reverse proxy (Coolify/Cloudflare) `req.nextUrl.origin` is the
 *  INTERNAL bind (e.g. http://0.0.0.0:3000), which a phone can never reach; the
 *  proxy forwards the real host in x-forwarded-host/-proto (or the Host header).
 *  An explicit APP_BASE_URL wins, for a deployment that wants to pin the domain. */
function publicOrigin(req: NextRequest): string {
  const override = process.env.APP_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, '');

  const h = req.headers;
  const host = h.get('x-forwarded-host') ?? h.get('host');
  // Ignore an internal/loopback host (the very thing that produced 0.0.0.0:3000).
  if (host && !/^(0\.0\.0\.0|127\.|\[::1?\]?|localhost)(:|$)/i.test(host)) {
    const proto =
      h.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
      // No proxy proto header → infer: a host with a port is a LAN/dev box (http),
      // a bare domain is public (https).
      (host.includes(':') ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  return req.nextUrl.origin;
}

// ── Branded QR renderer ──────────────────────────────────────────────────────
// The `qrcode` package's SVG output is hard black squares. We instead pull the
// raw module matrix and draw it ourselves: rounded modules in the brand ink,
// with the three finder "eyes" rendered as rounded rings in the accent — so the
// code matches the site instead of looking like a stock QR. Colours are literal
// (the SVG sits on a forced-white plate in both themes) and dark enough to scan.
const QR_INK = 'oklch(0.26 0.045 278)'; // deep brand indigo — data modules
const QR_EYE = 'oklch(0.53 0.2 280)'; // accent violet — finder eyes

function brandedQrSvg(url: string): string {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data; // 1 = dark module
  const margin = 2; // quiet zone (modules)
  const dim = size + margin * 2;

  const inFinder = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);

  // Data modules: soft rounded squares (touch their neighbours, so the code
  // reads as connected blobs rather than dots — keeps it reliably scannable).
  let cells = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!data[r * size + c] || inFinder(r, c)) continue;
      const x = margin + c;
      const y = margin + r;
      cells += `<rect x="${x}" y="${y}" width="1" height="1" rx="0.34" ry="0.34"/>`;
    }
  }

  // One finder eye: a rounded outer ring (the 7×7 border) + a rounded 3×3 pupil.
  const eye = (gr: number, gc: number) => {
    const x = margin + gc;
    const y = margin + gr;
    return (
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="2.1" ry="2.1" ` +
      `fill="none" stroke="${QR_EYE}" stroke-width="1"/>` +
      `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="1.1" ry="1.1" fill="${QR_EYE}"/>`
    );
  };

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
    `shape-rendering="geometricPrecision" role="img" aria-label="Sign-in QR code">` +
    `<g fill="${QR_INK}">${cells}</g>` +
    eye(0, 0) +
    eye(0, size - 7) +
    eye(size - 7, 0) +
    `</svg>`
  );
}

/** PRIVILEGED: an authenticated desktop mints a single-use ~60s QR handoff token
 *  bound to its session and gets back a QR (SVG) the phone can scan to sign in.
 *  The token rides in the URL FRAGMENT (#…) so it never reaches a server log. */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const label = deviceLabel(req.headers.get('user-agent'));
  const { token, expiresAt } = mintHandoff(label);

  // Point the phone at the SAME origin the operator reached us on (public domain
  // when remote, LAN IP when local). Fragment keeps the token off any server log.
  const url = `${publicOrigin(req)}/login/qr#${token}`;
  let qrSvg: string;
  try {
    qrSvg = brandedQrSvg(url);
  } catch {
    return NextResponse.json({ error: 'Could not render the QR code.' }, { status: 500 });
  }

  return NextResponse.json(
    { qrSvg, code: token, expiresAt, sourceLabel: label },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
