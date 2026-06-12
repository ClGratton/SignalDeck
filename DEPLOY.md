# Deploy checklist

Things only you can do — no code changes needed. Tick them off before going live.

## Cloudflare

- [ ] **Rate-limit `/login` at the WAF layer.**
  Security → WAF → Rate Limiting. Suggested rule: >10 requests/minute per IP → block for 10 minutes. This is a second layer on top of the in-app throttle; a bot that rotates proxies will hit the in-app limit per IP, but WAF-level blocking stops it before the request even reaches Node.

- [ ] **Expose the origin only through Cloudflare.**
  Best option: use a **Cloudflare Tunnel** (`cloudflared`) so nothing is open inbound at all — the tunnel dials out to Cloudflare, no port forwarding needed. Alternative: firewall the VPS/homelab to allow inbound 443 only from [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/). Either way the goal is: a direct hit to your origin IP must time out.

- [ ] **Set SSL/TLS mode to "Full (strict)".**
  Cloudflare dashboard → SSL/TLS → Overview. "Flexible" means CF→origin is plain HTTP, which lets anyone on the same network intercept the session cookie. "Full (strict)" requires a valid cert on the origin; use a Cloudflare Origin Certificate (free, issued in the dashboard) if you don't have a public cert on the box.

## Credentials

- [x] `AUTH_SECRET` generated (32+ random bytes via `openssl rand -base64 32`).
- [x] `TWO_FACTOR_SECRET` generated and loaded into authenticator app.
- [ ] **Set a long `DASHBOARD_PASSWORD`.** It is one of two factors; the TOTP is the other. A compromised password alone still requires the code, but there's no reason to leave it short.

## On the production host

- [ ] **Recreate `.env.local` by hand** from `.env.example`. Never copy it through chat, pastebins, GitHub, or any networked channel — even a private repo. The file is gitignored for a reason. Type or paste the values directly into the shell on the host.

---

**Note on HSTS:** the `Strict-Transport-Security` header in `next.config.mjs` is inert over plain HTTP and activates automatically once the site is served through Cloudflare's TLS. No code change needed; just deploy behind Cloudflare and it's live.
