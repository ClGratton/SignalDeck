# Deploying Grtlabs on Coolify (in your Proxmox homelab)

This app **must run inside the LAN** — it talks to Proxmox, TrueNAS, Home
Assistant, Jellyfin and SSH on `192.168.x` / `*.lan`. A cloud host can't reach
those, so we self-host. Coolify gives the Vercel-style "git push → auto-deploy"
loop on your own box, with env vars and TLS handled for you.

End state: push to `main` on GitHub → Coolify rebuilds the Docker image → the
new version is live on `grtlabs.xyz` through a Cloudflare Tunnel.

> Pair this with [`DEPLOY.md`](DEPLOY.md) — that's the go-live security checklist
> (WAF rate-limit on `/login`, origin reachable only via Cloudflare, SSL "Full
> (strict)"). Do those too.

---

## 0. What's already in the repo for this
- `output: 'standalone'` in `next.config.mjs` → self-contained server build.
- `Dockerfile` → Node 22, multi-stage, non-root, serves on port **3000**.
- `.dockerignore` → keeps secrets and `data/` out of the image.

Nothing secret is in the repo. All credentials are injected at runtime as
Coolify environment variables, and all runtime state lives in a **persistent
volume** mounted at `/app/data`.

---

## 1. Stand up Coolify (once)
Create a small VM or LXC on Proxmox for Coolify itself (keep it separate from the
app):
- **Debian 12** VM, 2 vCPU, 2–4 GB RAM, 30 GB disk. (Coolify needs Docker; a VM
  is the least-friction choice. If you use an LXC, it must be **privileged** with
  nesting + keyctl enabled, or Docker won't run.)
- Give it a static LAN IP (e.g. `192.168.1.30`).
- Install:
  ```bash
  curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
  ```
- Open `http://192.168.1.30:8000`, create the admin account. **Do not expose
  port 8000 to the internet** — manage Coolify over the LAN only (or behind
  Cloudflare Access).

---

## 2. Connect GitHub
In Coolify → **Sources** → add a **GitHub App** and authorize it on the
`ClGratton/SignalDeck` repo. The GitHub App (not a PAT) is what registers the
push webhook and pulls the code.

---

## 3. Create the application
- **+ New → Application → Public/Private Repository →** pick `SignalDeck`,
  branch `main`.
- **Build Pack: Dockerfile** (uses the `Dockerfile` in the repo root).
- **Port: 3000.**
- **Auto-deploy on push: ON** (this is the "recompile from GitHub" part).
- Keep it a **single instance** — the login throttle and TOTP replay guard are
  per-process by design; don't scale to 2+ without a shared store.

---

## 4. Environment variables (the old `.env.local`)
In the app's **Environment Variables** tab, add every value from your local
`.env.local`. Mark `NEXT_PUBLIC_*` as **"Available at build"**; everything else
is runtime-only (good — secrets never get baked into the bundle).

Copy these **exactly** from `.env.local` (especially `AUTH_SECRET` — changing it
invalidates every session and the "sign out everywhere" epoch):

| Variable | Notes |
|---|---|
| `AUTH_SECRET` | **Reuse the same value** as local. |
| `DASHBOARD_PASSWORD` | The login password. |
| `TWO_FACTOR_SECRET` | TOTP secret (same one in your authenticator). |
| `PROXMOX_HOST` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` / `PROXMOX_VERIFY_TLS` | |
| `TRUENAS_HOST` / `TRUENAS_API_KEY` / `TRUENAS_VERIFY_TLS` | |
| `HOMEASSISTANT_HOST` / `HOMEASSISTANT_TOKEN` / `HOMEASSISTANT_ENTITIES` | |
| `JELLYFIN_HOST` / `JELLYFIN_API_KEY` | |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` | for the traffic viz |
| `SSH_HOST` / `SSH_PORT` / `SSH_USER` / `SSH_PASSWORD` or `SSH_PRIVATE_KEY` | assistant shell |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` (+ any OpenAI/DeepSeek/GLM keys) | model providers |
| `ASSISTANT_MODEL` / `GEMINI_MODEL` | optional default-model overrides |
| `NEXT_PUBLIC_STATUS_POLL_SECONDS` | **build-time**; default 20 |

> Anything you'd rather not paste here you can also set later from the in-app
> **Settings** panel — it writes to `data/service-config.json` and overrides env.
> But `AUTH_SECRET`, `DASHBOARD_PASSWORD`, `TWO_FACTOR_SECRET` must be env vars.

`NODE_ENV=production` is set by the Dockerfile, so the session cookie gets its
`secure` flag automatically.

---

## 5. Persistent storage — **do not skip this**
The app writes runtime state to `data/`: chat history, saved model keys,
assistant memory, service-config overrides, the auth epoch + TOTP replay guard,
status history, model catalog. Without a volume, **every redeploy wipes all of
it** (and resets the epoch, signing you out).

In the app → **Storages → Add → Volume Mount**:
- **Name:** `grtlabs-data`
- **Mount Path:** `/app/data`

---

## 6. Migrate your existing data
Bring the `data/` you already have (chats, keys, memory, config) onto the volume.

1. Deploy once (Section 7) so the volume + container exist.
2. Copy your local `data/` files into the running container (run on the Coolify
   host; get the files there first via `scp ./data/* user@coolify:/tmp/data/`):
   ```bash
   # find the app container on the Coolify host
   docker ps --format '{{.ID}} {{.Names}}' | grep -i signaldeck

   # copy each state file into the volume (repeat per file)
   docker cp /tmp/data/assistant-chats.json   <container>:/app/data/
   docker cp /tmp/data/service-config.json    <container>:/app/data/
   docker cp /tmp/data/assistant-memory.json  <container>:/app/data/
   docker cp /tmp/data/assistant-keys.json    <container>:/app/data/
   docker cp /tmp/data/assistant-models.json  <container>:/app/data/
   docker cp /tmp/data/auth-state.json        <container>:/app/data/
   docker cp /tmp/data/status-history.json    <container>:/app/data/
   ```
   (Or copy straight into the host volume dir:
   `/var/lib/docker/volumes/<volume>/_data/`.)
3. Fix ownership and restart so it reads them:
   ```bash
   docker exec -u 0 <container> chown -R node:node /app/data
   ```
   Then **Restart** the app from Coolify.

> `assistant-chats.json` = chat history · `service-config.json` = credentials you
> saved from Settings · `assistant-keys.json` = stored model keys ·
> `assistant-memory.json` = the lab map/memory. `auth-state.json` carries the
> epoch + last-used TOTP step — copying it keeps codes single-use across the move.

---

## 7. Deploy
Hit **Deploy**. Coolify builds the Dockerfile and starts the container on
port 3000. The first build pulls the base image and runs `npm ci` + `next build`,
so it takes a few minutes; later pushes are faster.

---

## 8. Put it on grtlabs.xyz via Cloudflare Tunnel
You already proxy `grtlabs.xyz` through Cloudflare, so use a **Tunnel** — no
port-forwarding, no exposed home IP.

Either:
- **Coolify's built-in Cloudflare Tunnel** integration (Server → Cloudflare
  Tunnel), or
- a separate `cloudflared` container/service.

Map a hostname to the app's internal address:
- **Public hostname:** `dash.grtlabs.xyz` (or the apex you want)
- **Service:** `http://<coolify-app-internal-host>:3000`

In Cloudflare DNS this creates the proxied (orange-cloud) CNAME for the tunnel.
Because Cloudflare terminates TLS and forwards `cf-connecting-ip`, your security
headers (HSTS, `frame-ancestors 'none'`) and the per-client login throttle all
work. Optionally gate it further with **Cloudflare Access** in front of `/login`.

---

## 9. Verify
- Visit `https://dash.grtlabs.xyz` → landing page loads, status pulse animates.
- Sign in (password + TOTP) → the console opens; panels show live Proxmox /
  TrueNAS / Jellyfin / HA data (proves LAN reachability).
- Open the assistant → your migrated **chats are there**; Settings shows your
  saved credentials; memory notes are present.
- DevTools → Application → Cookies → the session cookie is `Secure`.

---

## 10. The everyday loop
Commit, `git push origin main` → Coolify auto-rebuilds and redeploys. The
`data/` volume persists across deploys, so chats/keys/memory survive every push.
(This also ends the dev-server flakiness — it's a real `next start` build now.)

### Gotchas
- **Single instance only** (throttle + replay state are per-process).
- Keep `*_VERIFY_TLS=true` unless a backend is self-signed.
- Back up the `grtlabs-data` volume periodically (chats, keys, config live there).
- Rotating `AUTH_SECRET` signs everyone out — expected.
