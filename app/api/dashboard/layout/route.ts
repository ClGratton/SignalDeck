import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { getLayout, setLayout, resetLayout } from '@/lib/dashboard/layout-store';

export const runtime = 'nodejs';

// PRIVILEGED: the operator's dashboard tile layout (one shared layout, single-user
// gate). GET returns the saved layout (or the default); PUT saves a new one;
// DELETE resets to the default. The layout is operator-config, not public.

export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { layout: getLayout() },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
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
  const incoming = (body && typeof body === 'object' && 'layout' in body) ? (body as { layout: unknown }).layout : body;
  try {
    const layout = setLayout(incoming);
    return NextResponse.json({ layout }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return NextResponse.json(
      { error: `Could not save layout (${e?.code ?? 'write error'}).` },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ layout: resetLayout() }, { headers: { 'Cache-Control': 'private, no-store' } });
}
