import { NextResponse } from 'next/server';
import { getTrafficSeries } from '@/lib/cloudflare';

// Sanitized aggregate request counts (no IPs/paths), safe to serve unauthenticated.
export const dynamic = 'force-dynamic';

export async function GET() {
  const series = await getTrafficSeries();
  return NextResponse.json(
    { enabled: series !== null, series },
    {
      headers: {
        // Edge-cacheable: a CDN in front (your Cloudflare proxy) can serve every
        // visitor from cache for ~25s, so the origin is hit roughly once per window
        // no matter how many people are on the page. The upstream Cloudflare API is
        // separately throttled inside lib/cloudflare.ts, so even a cache miss can't
        // flood it. stale-while-revalidate keeps responses instant during refresh.
        'Cache-Control': 'public, max-age=0, s-maxage=25, stale-while-revalidate=120',
      },
    },
  );
}
