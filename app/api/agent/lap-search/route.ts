import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { hasWebSearch, webSearch } from '@/lib/assistant/web';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (message: string, status: number) => NextResponse.json({ error: message }, { status, headers });
async function matches(value: string | undefined, path: string | undefined): Promise<boolean> {
  if (!value || !path) return false;
  try {
    const expected = Buffer.from((await readFile(path, 'utf8')).trim());
    const supplied = Buffer.from(value);
    return expected.length >= 32 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
  } catch { return false; }
}
async function readBody(req: NextRequest): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2048) { await reader.cancel(); throw new Error('too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function publicUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return null;
    if (/^(localhost|.*\.(?:local|internal))$/i.test(u.hostname)) return null;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) || u.hostname.includes(':')) return null;
    return u.href;
  } catch { return null; }
}
export async function POST(req: NextRequest) {
  if (req.headers.has('origin') || req.headers.has('cf-ray') || req.headers.has('cf-connecting-ip')) return error('not found', 404);
  const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  const relay = req.headers.get('x-lap-relay-token') ?? undefined;
  if (!(await matches(relay, process.env.LAP_SEARCH_RELAY_TOKEN_FILE))) return error('not found', 404);
  if (!(await matches(auth?.[1], process.env.LAP_SEARCH_TOKEN_FILE))) return error('unauthorized', 401);
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return error('Expected JSON.', 415);
  let body: unknown;
  try { body = JSON.parse(await readBody(req)); } catch { return error('Invalid or oversized JSON.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'query')) return error('Provide one query.', 400);
  const query = (body as {query?: unknown}).query;
  if (typeof query !== 'string' || !query.trim() || query.length > 400) return error('Query must be 1–400 characters.', 400);
  if (!hasWebSearch()) return error('Public search is unavailable.', 503);
  try {
    const result = await webSearch(query.trim(), { max: 4, topic: 'general' });
    const sources = result.results.flatMap(r => {
      const url = publicUrl(r.url);
      return url ? [{ title: r.title.slice(0, 180), url, snippet: r.snippet.slice(0, 300) }] : [];
    }).slice(0, 4);
    return NextResponse.json({ answer: result.answer?.slice(0, 1000) ?? '', sources }, { headers });
  } catch { return error('Public search failed or timed out.', 502); }
}
