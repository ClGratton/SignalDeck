import { NextResponse } from 'next/server';
import { getAggregateStatus } from '@/lib/status-source';

// Sanitized aggregate data, safe to serve unauthenticated.
export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await getAggregateStatus();
  return NextResponse.json(status, {
    headers: {
      // Edge-cacheable so a CDN serves all visitors from cache; the pulse only
      // needs ~10s freshness (the client ticks uptime locally between polls). When
      // the dashboard wires real backends, getAggregateStatus() will fan out behind
      // a server-side cache + coalescing (see lib/cloudflare.ts), so visitor count
      // never multiplies backend probes.
      'Cache-Control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=30',
    },
  });
}
