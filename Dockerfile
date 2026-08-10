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

# OpenAI computer-use runs in a disposable, headless Chromium context. Install
# only the system browser (playwright-core supplies the driver); no browser
# profile or credentials are baked into the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Next's standalone bundle (server.js + traced node_modules), static assets,
# and the public dir. /app/data is the persistent runtime state (see compose).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Runtime state lives here; mount a volume so redeploys keep it.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "server.js"]
