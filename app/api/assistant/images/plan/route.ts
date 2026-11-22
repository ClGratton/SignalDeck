import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { relayFetch } from '@/lib/image-relay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 200;
const json = (body: unknown, status: number) => NextResponse.json(body, { status });
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const OPS = ['recolor', 'replace', 'remove', 'add', 'style'];

/**
 * Session-gated proxy to the relay's local AI edit planner (POST /plan, ~75-80 s cold).
 * multipart: image (client already downscaled to <= 1024 px), instruction, optional same-size mask.
 * Returns a sanitized plan; box is in the pixels of the image that was sent (the client rescales it).
 */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) return json({ error: 'unauthorized' }, 401);
  try {
    if (Number(req.headers.get('content-length') ?? 0) > 8 * 1024 * 1024) return json({ error: 'Image too large.' }, 413);
    const form = await req.formData();
    const image = form.get('image'); const mask = form.get('mask'); const instruction = str(form.get('instruction'), 1000);
    if (!(image instanceof File) || image.size < 100 || image.size > 6 * 1024 * 1024) return json({ error: 'Send an image.' }, 400);
    if (instruction.length < 2) return json({ error: 'Describe the change you want.' }, 400);
    const out = new FormData();
    out.set('image', image, 'image.jpg');
    out.set('instruction', instruction);
    if (mask instanceof File) {
      if (mask.size < 60 || mask.size > 2 * 1024 * 1024) return json({ error: 'Bad mask.' }, 400);
      out.set('mask', mask, 'mask.png');
    }
    const res = await relayFetch('/plan', { method: 'POST', body: out }, 170000);
    if (res.status === 409 || res.status === 429) return json({ error: 'The image service is busy. Try again shortly.' }, 409);
    if (!res.ok) return json({ error: 'The planner is unavailable.' }, res.status >= 500 ? 503 : 502);
    const d = await res.json();
    const op = OPS.includes(d.op) ? d.op : 'replace';
    const box = Array.isArray(d.box) && d.box.length === 4 && d.box.every(fin) ? d.box.map(Number) : null;
    return json({
      op,
      target: str(d.target, 120),
      color: typeof d.color === 'string' && /^[#\w .-]{1,40}$/.test(d.color) ? d.color : null,
      image_prompt: str(d.image_prompt, 1000),
      negative_prompt: str(d.negative_prompt, 500),
      strength: fin(d.strength) ? Math.min(1, Math.max(0.05, d.strength)) : 0.6,
      grow: fin(d.grow) ? Math.min(32, Math.max(0, Math.round(d.grow))) : 8,
      context: fin(d.context) ? Math.min(3, Math.max(1, d.context)) : 1.5,
      box, confidence: fin(d.confidence) ? d.confidence : null,
      source: d.source === 'llm' ? 'llm' : 'fallback',
      reason: str(d.reason, 160) || undefined,
      prefill: d.prefill === true,
    }, 200);
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return json({ error: timeout ? 'The planner took too long.' : 'The planner is unavailable.' }, 503);
  }
}
