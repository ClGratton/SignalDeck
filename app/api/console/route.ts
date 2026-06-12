import { NextResponse } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { getConsoleSnapshot } from '@/lib/console';

export const runtime = 'nodejs';

/** PRIVILEGED: the full operator snapshot (guest names, datasets, sessions…).
 *  Session-gated — this is exactly the data the public /api/status must never
 *  serve. The dashboard polls it to stay live. */
export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const snapshot = await getConsoleSnapshot();
  return NextResponse.json(snapshot, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
