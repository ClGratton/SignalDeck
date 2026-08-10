import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { deleteChat, readChats, writeChats } from '@/lib/assistant/chat-store';

export const runtime = 'nodejs';

// PRIVILEGED: the operator's assistant chat history, centralized server-side so
// it is identical on every browser/device (it used to be per-browser
// localStorage). Single-user dashboard → one shared collection. Transcripts hold
// rich operator data, so every handler starts with hasValidSession().

export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(readChats(), { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function PUT(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const result = writeChats(body);
  if (!result.ok) return NextResponse.json({ error: result.detail }, { status: 400 });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function DELETE(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let id = '';
  try {
    const body = (await req.json()) as { id?: unknown };
    if (typeof body.id === 'string') id = body.id;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!/^[\w-]{1,64}$/.test(id)) {
    return NextResponse.json({ error: 'invalid chat id' }, { status: 400 });
  }
  const result = deleteChat(id);
  if (!result.ok) return NextResponse.json({ error: result.detail }, { status: 400 });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } });
}
