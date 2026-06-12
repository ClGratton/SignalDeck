import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/spline-sans-mono';
import './globals.css';
import { themeInitScript } from '@/lib/theme';
import { ThemeProvider } from '@/components/ThemeProvider';
import { StatusProvider } from '@/components/StatusProvider';
import { TrafficProvider } from '@/components/TrafficProvider';
import { TelemetryCanvas } from '@/components/TelemetryCanvas';
import { BrandNav } from '@/components/BrandNav';
import { PageTransition } from '@/components/PageTransition';
import { FirstLoadReset } from '@/components/FirstLoadReset';
import { DebugPanel } from '@/components/DebugPanel';
import { peekAggregateStatus } from '@/lib/status-source';
import { peekTrafficSeries } from '@/lib/cloudflare';
import { lab } from '@/lib/config';

export const metadata: Metadata = {
  title: `${lab.name} — homelab`,
  description:
    'The front door to a self-hosted homelab. Live infrastructure and operational stats sit behind the console; everything healthy, at a glance.',
  applicationName: lab.name,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7f8' },
    { media: '(prefers-color-scheme: dark)', color: '#14171c' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Read at the layout so the ambient telemetry background and live status are
  // shared by every route. NEVER awaited: the layout renders on every server
  // render (each navigation, login/logout included), so it must not block on
  // backend probes — peek serves the cache and refreshes in the background,
  // and the client's /api/status + /api/traffic polling keeps it live.
  const status = peekAggregateStatus();
  const traffic = peekTrafficSeries();

  return (
    <html lang="en" className="first-load" suppressHydrationWarning>
      <body>
        {/* Sets the theme attribute before paint to avoid a flash of the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <ThemeProvider>
          <StatusProvider initial={status}>
            <TrafficProvider initial={traffic}>
              <TelemetryCanvas />
              <BrandNav />
              <FirstLoadReset />
              <PageTransition>{children}</PageTransition>
            </TrafficProvider>
          </StatusProvider>
        </ThemeProvider>
        <DebugPanel />
      </body>
    </html>
  );
}
