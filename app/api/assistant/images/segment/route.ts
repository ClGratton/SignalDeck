import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { relayFetch } from '@/lib/image-relay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status: number) => NextResponse.json(body, { status });
const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/**
 * Session-gated proxy to the relay's segmentation service.
 *  - multipart `image`            -> POST /segment/embed   -> {key,width,height}
 *  - JSON {key,points,box}        -> POST /segment/predict -> {mask(base64 PNG 0/255),score}
 */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) return json({ error: 'unauthorized' }, 401);
  try {
    const type = req.headers.get('content-type') ?? '';
    if (type.startsWith('multipart/form-data')) {
      if (Number(req.headers.get('content-length') ?? 0) > 12 * 1024 * 1024) return json({ error: 'Image too large.' }, 413);
      const form = await req.formData();
      const image = form.get('image');
      if (!(image instanceof File) || image.size < 100 || image.size > 12 * 1024 * 1024) return json({ error: 'Send an image.' }, 400);
      const out = new FormData(); out.set('image', image, 'image.jpg');
      const res = await relayFetch('/segment/embed', { method: 'POST', body: out }, 60000);
      if (!res.ok) return json({ error: 'Selection service unavailable.' }, res.status >= 500 || res.status === 404 ? 503 : 502);
      const d = await res.json();
      if (typeof d.key !== 'string' || !fin(d.width) || !fin(d.height)) throw new Error('bad embed response');
      return json({ key: d.key, width: d.width, height: d.height }, 200);
    }
    const b = await req.json().catch(() => null);
    const key = b?.key;
    if (typeof key !== 'string' || !/^[\w-]{4,128}$/.test(key)) return json({ error: 'Bad request.' }, 400);
    const pts = Array.isArray(b.points) ? b.points : [];
    if (pts.length > 32 || pts.some((p: any) => !fin(p?.x) || !fin(p?.y) || (p.label !== 0 && p.label !== 1))) return json({ error: 'Bad points.' }, 400);
    const box = b.box == null ? null : b.box;
    if (box !== null && !(Array.isArray(box) && box.length === 4 && box.every(fin))) return json({ error: 'Bad box.' }, 400);
    if (!pts.length && !box) return json({ error: 'Nothing to select.' }, 400);
    const res = await relayFetch('/segment/predict', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, points: pts.map((p: any) => ({ x: p.x, y: p.y, label: p.label })), box }),
    }, 30000);
    if (res.status === 404) return json({ error: 'unknown key' }, 404);
    if (!res.ok) return json({ error: 'Selection service unavailable.' }, res.status >= 500 ? 503 : 502);
    const d = await res.json();
    if (typeof d.mask !== 'string') throw new Error('bad predict response');
    return json({ mask: d.mask, score: fin(d.score) ? d.score : null }, 200);
  } catch { return json({ error: 'Selection service unavailable.' }, 503); }
}
