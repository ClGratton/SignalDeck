/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Build a self-contained server (.next/standalone) so the production Docker
  // image only needs Node + the traced deps — no full node_modules, no source.
  // This is what `node server.js` runs in the container (see Dockerfile).
  output: 'standalone',

  // ssh2 ships native/non-ESM crypto that the bundler can't place into a chunk
  // (the production build fails otherwise). Keep it an external runtime require;
  // standalone tracing still copies it into the image's node_modules.
  serverExternalPackages: ['ssh2'],

  // Dev only: when you open the dev server from another device on your LAN
  // (e.g. http://192.168.1.44:3000 on your phone), Next blocks cross-origin
  // requests to its /_next dev + HMR assets by default. That blocks the client
  // bundle, so the page renders its server HTML but never hydrates — the clock
  // stays on its placeholder, the theme toggle and popover don't respond, and the
  // canvas never animates. Listing the LAN origin(s) here unblocks them.
  // Add whatever IPs/hostnames you actually reach the dev server from.
  allowedDevOrigins: ['192.168.1.44', '192.168.1.*'],

  // Baseline security headers on every response. Browsers ignore HSTS over plain
  // HTTP, so it's inert in dev and active behind Cloudflare's TLS in production.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // No page here has any business inside an iframe (clickjacking).
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          // Don't let browsers sniff responses into other content types.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Outbound links learn the origin at most, never full URLs.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // This app never needs these browser capabilities.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          // 6 months of HTTPS-only once seen over HTTPS.
          { key: 'Strict-Transport-Security', value: 'max-age=15552000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default nextConfig;
