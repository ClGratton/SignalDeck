# Grtlabs — project instructions

Personal homelab dashboard: public landing + status page, auth-gated operator
console. Next.js 16 App Router (Turbopack), React 19, TypeScript, CSS Modules,
OKLCH dual theme. Dev server is usually already running on :3000 (LAN-exposed,
tested on a real phone at http://192.168.1.44:3000).

## Security invariants — never regress these

These are load-bearing. Do not weaken, remove, or "simplify" any of them without
the owner explicitly asking. When adding features, re-read this list.

### Secrets stay server-side

- `.env.local` is the only place real credentials live. It is gitignored; so is
  `/data/` (runtime state). Never commit either; never print secret VALUES into
  logs, errors, commit messages, or chat — key names only.
- Backend credentials are read ONLY in server-only modules (`lib/homelab.ts`,
  `lib/status-source.ts`, `lib/auth-store.ts`, server actions, API routes).
  Client components must never receive secrets as props — booleans like
  "2FA is enabled" are the most they may know (see `app/login/page.tsx`).
- Public API routes (`/api/status`, `/api/traffic`, `/api/history`) serve
  sanitized AGGREGATES only: counts, coarse health levels, the three traffic
  hostnames deliberately made public. No IPs, paths, tokens, VM names, or
  internal topology. Anything richer belongs behind the session check.

### Login (`app/login/actions.ts`) — properties that must hold

1. **Throttle first**: `checkThrottle()` runs before any credential work
   (`lib/login-throttle.ts` — per-IP exponential backoff + global circuit
   breaker). Every failure calls `recordFailure()`.
2. **Constant-time compares** for the password (`timingSafeEqual`) — never `===`.
3. **One generic error** for any bad-credential combination. Never reveal which
   factor was wrong; never verify the password before the TOTP code.
4. **TOTP** (`lib/totp.ts`): verified server-side only; matched step must be
   `> getLastTotpStep()` and is burned via `setLastTotpStep()` (persisted in
   `data/auth-state.json`) so codes are single-use even across restarts.
5. The `from` redirect accepts internal paths only (no `//` or absolute URLs).
6. Login form inputs are CONTROLLED (React state). React resets uncontrolled
   fields after a server action responds, which silently wipes the hidden
   password on a failed attempt — do not convert them back.

### Sessions

- Token = HMAC-SHA256(`g.<epoch>.<issuedAt>`) with `AUTH_SECRET`; cookie is
  `httpOnly`, `sameSite: lax`, `secure` in production, 7-day max age.
- The epoch (`lib/auth-store.ts`) is embedded in every token and checked on
  verify. "Sign out everywhere" bumps it, invalidating all sessions. Don't
  remove the epoch check or the nodejs runtime from `middleware.ts` (Edge can't
  read the epoch file).
- Every new privileged route MUST be covered: add it to the middleware matcher,
  or call `hasValidSession()` at the top. Privileged = anything beyond the
  sanitized public aggregates, and ANY route that performs an action on the
  homelab (restart a VM, etc.). Action routes deserve an extra confirmation
  step — a 7-day cookie is a long-lived credential.

### Operator assistant (console sidebar)

- `/api/console`, `/api/assistant`, `/api/assistant/execute`,
  `/api/assistant/decide`, `/api/assistant/models`, `/api/assistant/keys`,
  `/api/assistant/memory`, `/api/assistant/chats`, `/api/assistant/workspace`
  are PRIVILEGED: every one starts with `hasValidSession()`. They serve/act on
  the rich operator data (guest names, datasets, sessions, HA entities, full chat
  transcripts, per-chat plans/notes) that the public aggregates deliberately omit.
- Chat history is centralized server-side (`data/assistant-chats.json`, gitignored;
  via `/api/assistant/chats`) so it is identical across browsers/devices — a
  single shared collection (single-user gate). localStorage is only a same-browser
  cache + a one-time migration source; the server copy is the source of truth.
  Transcripts may hold operator data, so the route is session-gated like the rest;
  never store secrets in a transcript.
- Model keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, plus keys saved from the
  model menu into `data/assistant-keys.json`) are server-only; the client
  learns at most which provider is configured and whether its key is
  `env`/`stored`. The key store is WRITE-ONLY: no route, log, or error may
  ever echo a key value back out. Env keys always win over stored ones.
- The assistant has DIRECT, full API access to EVERY backend through one
  generic tool, `lab_request(service, method, path, body)` (`labRequest()` in
  `lib/console.ts`): proxmox/homeassistant/jellyfin/cloudflare REST and TrueNAS
  JSON-RPC, each resolved to its own base URL + auth + transport server-side.
  `guest_power`/`ha_service` are convenience wrappers. It can do anything the
  configured tokens permit. The guard rail is the OPERATOR's approval, not a
  narrow tool menu:
  - **Ask mode** = the propose pipeline: action tools register single-use,
    5-minute proposals (`lib/assistant/proposals.ts`); the executable closure
    stays server-side and runs ONLY via `/api/assistant/execute` after Confirm.
  - **Agent mode** = inline execution with an approval level (`lib/assistant/
    decisions.ts`): `all` confirms every action, `critical` auto-runs safe ones
    and confirms destructive ones (risk-classified in `tools.ts`), `auto` runs
    everything. Confirmation pauses the open NDJSON stream and resumes when the
    operator posts to `/api/assistant/decide`. The executable closure NEVER
    leaves the server.
  Never remove the risk classification, never let `critical`/`all` skip the
  confirm, and never persist tokens client-side. `auto` is an explicit,
  owner-chosen mode — not a default to widen silently.
- Model-key and backend-credential VALUES may be revealed to the browser ONLY
  through the re-auth-gated reveal routes (`/api/assistant/keys/reveal`,
  `/api/settings/reveal`), which require a fresh password + TOTP (`lib/reauth.ts`,
  same replay guard as login) on top of the session and return the value once.
  Everywhere else keys stay write-only/server-only. Do not add an unauthenticated
  read path.

### Assistant knowledge tiers — where each fact lives (decide with the test below)

Before baking ANY lab detail into code or prompt, ask: **would this still be
true if I released the project for someone else's setup, and will it still be
true for the owner in 3 months after they change things?** If no, it must NOT be
hardcoded. (Hardcoding the owner's container list was the blunder this rule
exists to prevent.) The four tiers:

- **Hardcoded (code + `lib/assistant/reference.ts` + the core prompt)** — only
  GENERIC capability knowledge true for every deployment: that the backends
  exist and the SHAPE of their APIs (endpoints with `{placeholders}`, never real
  vmids/hostnames), how SSH/`pct exec` works, the approval rules. Detailed
  per-service endpoint cheatsheets live in `reference.ts` and are pulled on
  demand via the `read_reference` tool, NOT sent every message.
- **Core prompt (`lib/assistant/prompt.ts`)** — the lean, STABLE instruction set
  (identity, how actions run, memory discipline, formatting). It is sent on every
  request by necessity (stateless chat APIs have no "check it anytime" store), so
  keep it small: the stable prefix is structured for provider PROMPT CACHING (the
  date is appended last), which is what makes the repetition cheap. Heavy detail
  belongs in `reference.ts` behind `read_reference`, not here.
- **Global memory (`data/assistant-memory.json`, operator-visible)** — durable,
  lab-SPECIFIC facts: the topology map (guest→vmid/node), quirks ("X is a
  community LXC"), discovered entity ids. The model builds the map from
  `/cluster/resources` if missing, treats it as possibly stale, and re-saves on
  contradiction. NEVER hardcode these.
- **Chat-scoped (per-chat workspace)** — one-off tasks and intent for the current
  conversation. These must NEVER go to global memory. They live in the per-chat
  workspace (`lib/assistant/chat-workspace.ts`, `data/assistant-workspace.json`,
  gitignored; keyed by chatId): `note_to_self` for chat-only facts, and
  `plan_set`/`plan_update` for a checklist the model builds for LONG multi-step
  tasks only. Injected into the prompt for that chat, streamed to the UI via the
  `workspace` event, shown to the operator as a pinned card they can clear.

### Headers & transport

- The security headers in `next.config.mjs` (`frame-ancestors 'none'`,
  `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS)
  apply to every route. Keep them when touching the config.
- TLS verification to backends defaults ON; `*_VERIFY_TLS=false` is a per-host,
  owner-set exception for self-signed labs, never a code default.

### Known accepted limits (don't "fix" silently)

- Throttle + replay state are per-process (single-instance deploy). If this app
  ever runs multi-instance, move `lib/login-throttle.ts` + `lib/auth-store.ts`
  to a shared store first.
- In LAN dev every client shares the 'local' throttle bucket (no proxy headers);
  in production Cloudflare's `cf-connecting-ip` separates clients.

## Conventions

- Client-safe vs server-only module split: types + pure helpers live in files
  importable by client components (`lib/status.ts`, `lib/history.ts`); anything
  touching `node:*`, `fs`, or credentials lives in server-only files
  (`lib/status-source.ts`, `lib/history-store.ts`, `lib/homelab.ts`). Turbopack
  cannot resolve bare `undici`/`ws` — use `node:http(s)` and the global
  `WebSocket` (Node 22).
- Status history: real recorded data only (`data/status-history.json`). Days
  without samples render gray "no data", never a fabricated level.
- The root layout (and any page a redirect lands on: `/`, `/dashboard`) must
  NEVER await backend probes — use the `peek*` variants (`peekAggregateStatus`,
  `peekTrafficSeries`, `peekHomelabSummary`), which serve the cache instantly
  and refresh in the background. Blocking there made every navigation hang for
  seconds whenever a backend was slow or unreachable. Only the polling API
  routes (`/api/status`, `/api/traffic`) may await the blocking variants.
- Login history model: `/login` is always exactly ONE history entry. The
  password→code step is pure component state — NEVER `history.pushState` /
  `history.back()` choreography (it races Next's router; it caused a
  dashboard⇄login back-trap). The corner brand control dispatches a cancelable
  `grtlabs:back` event the form claims to step code→password. Successful
  sign-in finishes with `router.replace(dest)` so the console replaces `/login`
  in history, and `/login` server-redirects already-authed visitors. Together:
  Back from the console always returns to the landing page, no trap.
- Verify with `npx tsc --noEmit` before calling work done.
- After a burst of source edits, RESTART the dev server before measuring
  performance or letting the owner test. Turbopack on this Windows machine
  degrades after rapid multi-file edits (every route renders in 7–12s until
  restart); a fresh server renders the same routes in well under a second.
  Never diagnose "the app is slow" from a post-edit dev server.
