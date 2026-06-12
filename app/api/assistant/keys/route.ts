import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import {
  PROVIDERS,
  keySource,
  setStoredKey,
  clearStoredKey,
  getProviderBaseUrl,
} from '@/lib/assistant/keys';
import type { AssistantProvider } from '@/lib/assistant/types';

export const runtime = 'nodejs';

// PRIVILEGED + WRITE-ONLY: keys go in, never come back out (reveal is a separate
// re-auth-gated route). Responses carry provider STATUS only — never key values.

const isProvider = (v: unknown): v is AssistantProvider =>
  PROVIDERS.some((p) => p.id === v);

const statusPayload = () => ({
  providers: PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    source: keySource(p.id),
    customBaseUrl: p.kind === 'openai',
    baseUrl: getProviderBaseUrl(p.id) ?? undefined,
  })),
});

export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { provider?: unknown; key?: unknown; baseUrl?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!isProvider(body.provider) || typeof body.key !== 'string') {
    return NextResponse.json({ error: 'provider and key are required' }, { status: 400 });
  }
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : undefined;
  const problem = setStoredKey(body.provider, body.key, baseUrl);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  return NextResponse.json(statusPayload(), { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { provider?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!isProvider(body.provider)) {
    return NextResponse.json({ error: 'provider is required' }, { status: 400 });
  }
  if (keySource(body.provider) === 'env') {
    return NextResponse.json(
      { error: 'This key comes from .env.local — remove it there.' },
      { status: 409 },
    );
  }
  clearStoredKey(body.provider);
  return NextResponse.json(statusPayload(), { headers: { 'Cache-Control': 'private, no-store' } });
}
