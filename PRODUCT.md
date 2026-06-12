# Product

## Register

product

## Users

**Primary — the homelab owner (you).** Opens the dashboard daily, likely as a browser start page or on a wall/tablet display, to launch self-hosted services and read infrastructure health at a glance. Technical, comfortable with raw metrics, wants signal density over hand-holding.

**Secondary — anonymous visitors.** Anyone who hits the public root. They must never land on a bare login form; they get a deliberately cool, on-brand front door that hints at what's behind it without leaking internals. Every operational route is authentication-protected; real stats and controls appear only once signed in.

## Product Purpose

A single home base for a personal homelab: a public face worth looking at, and behind authentication, a live operational console that aggregates four backends:

- **Proxmox** — node CPU/RAM usage, VM/CT status (running/stopped), uptime.
- **TrueNAS SCALE** — pool health, per-dataset used/free space, disk temperatures.
- **Home Assistant** — a handful of key entity states (specific entities TBD).
- **Jellyfin** — now playing, recent media, active sessions.

All backend calls run server-side so secrets never reach the browser. Success = open it, know in one glance whether everything is healthy, and reach any service in one click.

**Integration plan** (architecture — flexible; a better approach wins):

- Framework: Next.js (App Router) — server components + route handlers keep every fetch server-side; middleware guards dashboard routes.
- Proxmox: `proxmox-api` npm package.
- TrueNAS SCALE: REST API v2 (direct server-side fetch).
- Home Assistant: `home-assistant-js-websocket` or the REST API.
- Jellyfin: `@jellyfin/sdk`.
- Config: all service URLs, ports, and API keys/tokens live in `.env.local` (gitignored, never shipped); a committed `.env.example` documents every required key with placeholders.
- Headroom for personal/custom panels beyond the four services (placeholders welcome until real data is wired).

## Brand Personality

Nerdy, but clean and modern — **modern first, with a measured touch of nerd.** The voice of a competent operator's console: precise, quietly confident, a little playful in the details (a boot-sequence flourish, a monospace readout) without ever tipping into clutter or kitsch. Grafana/Observable's data honesty crossed with the restraint of a well-made TUI (btop, lazygit). Calm under load: it should feel fast and legible even when every panel is lit up.

## Anti-references

Steer clear of all four:

- **Generic SaaS / Bootstrap** — rounded cards everywhere, purple gradients, stock illustrations, tracked-uppercase eyebrows on every section. The "AI made this" look.
- **RGB gamer clutter** — neon overload, aggressive angles, busy wallpapers, more-is-more.
- **Stock homelab dashboards** — the default Heimdall / Organizr / Dashy tile grid every setup looks identical to. We are explicitly not that.
- **Corporate enterprise admin** — stiff gray IBM-ish panels, soulless density, zero character.

## Design Principles

1. **Signal over chrome.** Every pixel earns its place by carrying status or enabling an action. No decoration that doesn't inform.
2. **Honest data, legible at a glance.** Real numbers, sparklines, and charts (Grafana-honest), not vanity gauges. Health readable in under a second.
3. **Tasteful nerd, not costume nerd.** Monospace and terminal cues are seasoning (data readouts, the landing flourish), never the whole meal. When in doubt, modern and clean wins.
4. **The front door is a statement.** Anonymous visitors get something genuinely cool, never a login prompt. The public surface shows craft without exposing internals.
5. **Secrets stay server-side.** Server-only data fetching is a design constraint, not just a security one. The UI is built around what a server component can safely render.

## Security invariants

The full, binding list lives in `CLAUDE.md` ("Security invariants — never
regress these") and must be re-read before changing auth, APIs, or config. The
short form: secrets exist only in `.env.local` and server-only modules; public
APIs serve sanitized aggregates only; the login flow keeps its throttle,
constant-time compares, single generic error, and single-use persisted TOTP;
sessions are epoch-revocable and every privileged route is covered by the
middleware or `hasValidSession()`; the security headers in `next.config.mjs`
stay. These are product requirements, not implementation details.

## Accessibility & Inclusion

No formal WCAG target set by the owner. Baseline craft holds regardless: ≥4.5:1 body contrast (no muted-gray-on-dark mush), visible keyboard focus, and reduced-motion fallbacks for the landing/boot animations. Because health is color-coded (green/yellow/red), **always pair color with an icon or shape/label** so status survives color blindness and fast glancing — good practice even without a formal requirement.
