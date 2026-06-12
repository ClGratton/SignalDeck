import { NextResponse } from 'next/server';
import { getHistoryRecord } from '@/lib/history-store';
import { buildServiceHistories } from '@/lib/history';

// Sanitized daily status history (service names + coarse daily level), safe to
// serve unauthenticated. Powers month navigation on the status page.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const now = new Date();
  const today = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };

  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month')); // 0-based
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
    return NextResponse.json({ error: 'bad year/month' }, { status: 400 });
  }
  // Never serve future months beyond the current one.
  if (year > today.y || (year === today.y && month > today.m)) {
    return NextResponse.json({ error: 'future month' }, { status: 400 });
  }

  const histories = buildServiceHistories(year, month, today, getHistoryRecord());
  return NextResponse.json({ histories, today });
}
