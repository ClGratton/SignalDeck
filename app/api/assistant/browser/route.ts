import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import {
  getPublicBrowserComputer,
  type ComputerAction,
  type BrowserTarget,
} from '@/lib/assistant/computer';
import type { BrowserViewportDto } from '@/lib/assistant/types';

export const runtime = 'nodejs';

/** PRIVILEGED: returns pixels + public URL/title only. Browser cookies, local
 * storage, and entered credentials stay entirely server-side. */
function viewport(value: unknown): BrowserViewportDto | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const width = Number(record.width);
  const height = Number(record.height);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function target(body: Record<string, unknown>): BrowserTarget {
  return {
    ...(typeof body.tabId === 'string' ? { tabId: body.tabId } : {}),
    ...(viewport(body.viewport) ? { viewport: viewport(body.viewport) } : {}),
  };
}

async function timedFrame<T extends object>(work: () => Promise<T>): Promise<NextResponse> {
  const started = performance.now();
  const frame = await work();
  const latencyMs = Math.round(performance.now() - started);
  return NextResponse.json({ ...frame, latencyMs }, {
    headers: { 'Server-Timing': `browser;dur=${latencyMs}` },
  });
}

export async function GET(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const width = Number(req.nextUrl.searchParams.get('width'));
    const height = Number(req.nextUrl.searchParams.get('height'));
    const tabId = req.nextUrl.searchParams.get('tabId') ?? undefined;
    const requestedViewport = Number.isFinite(width) && Number.isFinite(height)
      ? { width, height }
      : undefined;
    return await timedFrame(() => getPublicBrowserComputer().snapshot({
      ...(tabId ? { tabId } : {}),
      ...(requestedViewport ? { viewport: requestedViewport } : {}),
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Browser unavailable.';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  try {
    const browser = getPublicBrowserComputer();
    const browserTarget = target(body);
    if (typeof body.navigate === 'string') {
      return await timedFrame(() => browser.navigate(body.navigate as string, browserTarget));
    }
    if (Array.isArray(body.actions)) {
      return await timedFrame(() => browser.run(body.actions as ComputerAction[], undefined, browserTarget));
    }
    if (body.command === 'new_tab') {
      return await timedFrame(() => browser.newTab(
        typeof body.url === 'string' ? body.url : undefined,
        browserTarget,
      ));
    }
    if (body.command === 'activate_tab' && typeof body.tabId === 'string') {
      return await timedFrame(() => browser.activateTab(body.tabId as string, browserTarget.viewport));
    }
    if (body.command === 'close_tab' && typeof body.tabId === 'string') {
      return await timedFrame(() => browser.closeTab(body.tabId as string, browserTarget.viewport));
    }
    if (body.command === 'back' || body.command === 'forward' || body.command === 'reload') {
      return await timedFrame(() => browser.history(body.command as 'back' | 'forward' | 'reload', browserTarget));
    }
    if (body.command === 'resize') {
      return await timedFrame(() => browser.snapshot(browserTarget));
    }
    return NextResponse.json({ error: 'navigate, actions, or browser command required' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Browser action failed.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
