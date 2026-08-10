import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import {
  getPublicBrowserComputer,
  type ComputerAction,
} from '@/lib/assistant/computer';

export const runtime = 'nodejs';

/** PRIVILEGED: returns pixels + public URL/title only. Browser cookies, local
 * storage, and entered credentials stay entirely server-side. */
export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json(await getPublicBrowserComputer().snapshot());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Browser unavailable.';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { navigate?: unknown; actions?: unknown };
  try {
    body = (await req.json()) as { navigate?: unknown; actions?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  try {
    const browser = getPublicBrowserComputer();
    if (typeof body.navigate === 'string') {
      return NextResponse.json(await browser.navigate(body.navigate));
    }
    if (Array.isArray(body.actions)) {
      return NextResponse.json(await browser.run(body.actions as ComputerAction[]));
    }
    return NextResponse.json({ error: 'navigate or actions required' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Browser action failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
