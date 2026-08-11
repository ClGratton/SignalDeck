# ── Production image for the Grtlabs dashboard ──────────────────────────────
# Multi-stage: build with the full toolchain, then ship only Next's standalone
# output on a slim Node 22 runtime (the app uses Node-22 globals like WebSocket).
# Secrets are NEVER baked in — they arrive as runtime env vars from Coolify.

# 1) deps — install everything (incl. devDeps) for the build
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# 2) build — compile the standalone server
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# 3) run — minimal runtime
FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99

# Run the shared browser as regular headed Chromium inside a private virtual
# display. Its user-data directory lives under /app/data, so signed-in sessions
# and the browser identity survive app restarts and deployments without baking
# profile data or credentials into the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium xvfb ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Next's standalone bundle (server.js + traced node_modules), static assets,
# and the public dir. /app/data is the persistent runtime state (see compose).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# `playwright-core` reads runtime assets (including browsers.json) with ordinary
# Node resolution. Next's standalone file tracer only copies the JS files it can
# see statically, which leaves those assets out and makes importing the assistant
# task stack fail before any request can start. Overlay the complete package onto
# the traced node_modules; Chromium itself is still the system package above.
COPY --from=deps /app/node_modules/playwright-core ./node_modules/playwright-core

# Runtime state lives here; mount a volume so redeploys keep it.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & sleep 0.2; exec node server.js"]
