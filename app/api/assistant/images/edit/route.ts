import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { relayFetch } from '@/lib/image-relay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (body: unknown, status: number) => NextResponse.json(body, { status });
const ENGINES: string[] = ['kontext', 'fluxfill', 'sdxl'];
const ID = /^[0-9a-f]{32}$/;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Server-driven image edit. POST starts it ({edit_id} at once); the relay then plans, selects, prepares and generates on its
 * own, whether or not any browser is connected. GET ?id= reports the stage; DELETE ?id= cancels. All session-gated; the relay
 * token never leaves the server. multipart: image, instruction, optional mask (PNG, same size), optional overrides (JSON).
 */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) return json({ error: 'unauthorized' }, 401);
  try {
    if (Number(req.headers.get('content-length') ?? 0) > 17 * 1024 * 1024) return json({ error: 'Request exceeds 17 MB.' }, 413);
    const form = await req.formData();
    const image = form.get('image'); const mask = form.get('mask');
    const instruction = String(form.get('instruction') ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1000);
    const overrides = form.get('overrides');
    if (!(image instanceof File) || image.size < 100 || image.size > 12 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) return json({ error: 'Choose a PNG, JPEG or WebP up to 12 MB.' }, 400);
    if (instruction.length < 2) return json({ error: 'Describe the change you want.' }, 400);
    const out = new FormData();
    out.set('image', image, 'image');
    out.set('instruction', instruction);
    if (mask instanceof File) {
      const head = new Uint8Array(await mask.slice(0, 8).arrayBuffer());
      if (mask.size < 60 || mask.size > 4 * 1024 * 1024 || !PNG_SIG.every((b, i) => head[i] === b)) return json({ error: 'The mask must be a PNG up to 4 MB.' }, 400);
      out.set('mask', mask, 'mask.png');
    }
    if (typeof overrides === 'string' && overrides) {
      if (overrides.length > 2000) return json({ error: 'Invalid overrides.' }, 400);
      let parsed: Record<string, unknown>;
      try { const v = JSON.parse(overrides); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); parsed = v; } catch { return json({ error: 'Invalid overrides.' }, 400); }
      // `engine` is optional (absent = Auto, the relay picks); anything outside the allowlist is refused, never forwarded.
      if ('engine' in parsed && (typeof parsed.engine !== 'string' || !ENGINES.includes(parsed.engine))) return json({ error: 'Unknown engine.' }, 400);
      out.set('overrides', JSON.stringify(parsed));
    }
    const res = await relayFetch('/edit', { method: 'POST', body: out }, 40000);
    if (res.status === 400) {
      const reason = (await res.text().catch(() => '')).replace(/^invalid edit request:?\s*/, '').slice(0, 200).replace(/[^ -~]/g, '');
      return json({ error: `The image or request was rejected${reason ? `: ${reason}` : ''}.` }, 400);
    }
    const d = await res.json().catch(() => ({}));
    if (!res.ok || typeof d.edit_id !== 'string' || !ID.test(d.edit_id)) return json({ error: 'The image service is temporarily unavailable.' }, res.status === 409 || res.status === 429 ? res.status : 503);
    return json({ edit_id: d.edit_id }, 202);
  } catch { return json({ error: 'The image service is temporarily unavailable.' }, 503); }
}

export async function GET(req: NextRequest) {
  if (!(await hasValidSession())) return json({ error: 'unauthorized' }, 401);
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!ID.test(id)) return json({ error: 'Invalid edit ID.' }, 400);
  try {
    const res = await relayFetch(`/edit/${id}`, {}, 15000);
    if (res.status === 404) return json({ error: 'Edit not found.' }, 404);
    if (!res.ok) return json({ error: 'Image service is unavailable.' }, 502);
    return NextResponse.json(await res.json(), { headers: { 'Cache-Control': 'no-store' } });
  } catch { return json({ error: 'Image service is unavailable.' }, 502); }
}

export async function DELETE(req: NextRequest) {
  if (!(await hasValidSession())) return json({ error: 'unauthorized' }, 401);
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!ID.test(id)) return json({ error: 'Invalid edit ID.' }, 400);
  try {
    const res = await relayFetch(`/edit/${id}/cancel`, { method: 'POST' }, 15000);
    return json({ ok: res.ok }, res.ok ? 200 : 502);
  } catch { return json({ error: 'Image service is unavailable.' }, 502); }
}
