# Agent access: Claude Code / Codex → your homelab (LAN-only MCP)

Coding agents on your desktop PCs (Claude Code, Codex) can drive the lab directly
through the dashboard's MCP endpoint, `POST /api/agent/mcp`. Setup is done once
per desktop.

- **Where the credentials live.** The dashboard keeps every backend credential.
  Each desktop holds only its own agent token.
- **Who approves.** Calls run with **no dashboard approval**: the agent's own
  permission mode (Claude Code ask / auto, Codex approval policy) is the
  approval. Every call is logged under Settings → Agent access.
- **What the agent gets.** The lab tools, plus the **shared lab memory**: the
  same notes the dashboard assistant uses. They are included in the MCP server
  instructions, so the agent starts out knowing your lab map. Web access,
  browsing, planning and timers are not exposed; the agents have their own.

| Tool | Kind |
|---|---|
| `get_console_snapshot`, `lab_get`, `list_ha_entities`, `get_service_history`, `get_traffic`, `read_reference`, `list_memory` | read |
| `save_memory`, `update_memory`, `forget_memory` | lab memory |
| `lab_request`, `run_shell`, `guest_power`, `ha_service` | change things |

## How "LAN-only" is enforced

Inside the app, the route answers **404** unless all of these hold:

- **Agent access is switched on** (Settings → Agent access → *Allow external
  agents*, the kill switch).
- **The request did not come through Cloudflare.** A request carrying
  `cf-connecting-ip` or `cf-ray` is refused. Cloudflare always sets these
  headers, and a client can't strip them.
- **Every forwarded hop is inside the allowed networks.** That means every
  address in `X-Forwarded-For` / `X-Real-IP`. The default is the private
  ranges; you can set your own CIDRs in Settings. Any reverse proxy on the way
  in (NPM, Traefik, Caddy, cloudflared) appends the real client address, so an
  internet request that reaches your origin *without* Cloudflare is refused too.

After that, a browser request (one with an `Origin` header) gets **403**. That
blocks DNS rebinding. Last comes the per-desktop bearer token.

Add the edge layer too:

- **Cloudflare users:** add a WAF custom rule on your zone:
  - Expression: `(starts_with(http.request.uri.path, "/api/agent/"))`
  - Action: **Block**
- **Optionally:** firewall the dashboard's LAN port to your desktops.

## 1. Give the dashboard a LAN address

Agents need a URL that reaches the app **without** going through Cloudflare or
another public proxy. Any of these works:

- **Directly:** the host / container port, e.g. `http://<dashboard-lan-ip>:3000`.
- **Through your internal reverse proxy:** e.g. a Traefik / NPM / Caddy route on
  a LAN hostname or IP that forwards to the app. The proxy's `X-Forwarded-For`
  will carry the desktop's LAN IP, which passes the network check.
- **Plain HTTP or HTTPS:** plain HTTP means a device on your LAN could sniff a
  token. Prefer HTTPS if your internal proxy has a certificate the desktops
  trust.

Put the full endpoint (e.g. `http://192.168.1.10/api/agent/mcp`) in **Settings →
Agent access → LAN endpoint URL**. The setup snippets below are built from it.

## 2. Create a token per desktop

In **Settings → Agent access**, enter a label (e.g. `desk-pc / Claude Code`) and
click **Create token**. You'll be asked for your password + TOTP.

The token is shown **once**, together with ready-to-paste setup for Windows,
macOS / Linux, Claude Code and Codex, with the URL and token already filled in.
Revoke a desktop's token from the same list.

## 3. Claude Code

This repository is a Claude Code plugin marketplace
(`.claude-plugin/marketplace.json` → `integrations/grtlabs-plugin`):

```
/plugin marketplace add <owner>/<this-repo>      # or a local checkout path
/plugin install grtlabs@grtlabs
```

The plugin contains:

- **The `lab` MCP server.** It reads `GRTLABS_MCP_URL` and
  `GRTLABS_AGENT_TOKEN` from the environment. Its tools appear as
  `mcp__plugin_grtlabs_lab__<tool>`.
- **The `homelab` skill.** It loads automatically for lab questions. While it is
  active, the read tools and memory tools are pre-approved; the tools that
  change things follow your ask / auto mode.

To pre-approve the reads everywhere, add them to `permissions.allow` in
`~/.claude/settings.json`, e.g. `"mcp__plugin_grtlabs_lab__lab_get"`.

## 4. Codex

1. Add the `[mcp_servers.grtlabs]` block from the setup snippet (or from
   `integrations/codex/config.toml.example`) to `~/.codex/config.toml`.
2. Copy `integrations/grtlabs-plugin/skills/homelab/` to
   `~/.codex/skills/homelab/`.

## 5. Verify

From a desktop, list the tools:

```bash
curl -s -X POST "$GRTLABS_MCP_URL" -H "Authorization: Bearer $GRTLABS_AGENT_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then check that the public hostname is closed:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<your-public-host>/api/agent/mcp
```

Expect **403** (the WAF rule) or **404** (the in-app check). A **401** means an
internet request reached the token check: fix the edge layer before using any
token.
