// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the assistant's on-demand reference manual.
//
// This is the "look it up when you need it" material (per-service API endpoints,
// SSH usage) that would bloat the always-sent system prompt. It is NOT sent
// every message — the core prompt stays lean (and cacheable); the model pulls a
// topic via the read_reference tool only when it actually needs the detail.
//
// Everything here is GENERIC capability knowledge — true for any deployment, no
// specific hostnames/vmids. Lab-specific facts live in memory, never here.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';

export const REFERENCE_TOPICS = ['apis', 'ssh', 'memory'] as const;
export type ReferenceTopic = (typeof REFERENCE_TOPICS)[number];

const APIS = `# lab_request — per-service API cheatsheet

Pick the service; the server resolves base URL + auth. Explore with reads first, then act.

## proxmox  (Proxmox VE REST, /api2/json)
- GET /cluster/resources — the source of truth for vmids, nodes, status, type (qemu|lxc). Snapshot vmids can be stale; trust this.
- GET /nodes/{node}/{lxc|qemu}/{vmid}/config — guest config.
- POST /nodes/{node}/{lxc|qemu}/{vmid}/status/{start|shutdown|stop|reboot} — power (or use guest_power).
- DELETE /nodes/{node}/{lxc|qemu}/{vmid} — DESTROY (guest must be stopped first).
- The REST API CANNOT exec inside a guest or open a shell (you'll get 501) — use run_shell for that.

## homeassistant  (two transports, chosen by the path)
REST (path STARTS WITH "/", under /api/):
- GET /api/states , /api/error_log , /api/logbook/{ISO_ts} , /api/history/period/{ISO_ts}
- POST /api/template  body {"template":"..."} — render a value.
- GET /api/config/config_entries  →  DELETE /api/config/config_entries/entry/{entry_id} removes an integration + its devices/entities.
WebSocket (path has NO leading slash = the command type, body = the rest of the message). The registry is WS-only and the server holds the token, so do this here — never SSH into the HA container (its env is blank, no token):
- "config/entity_registry/list" ; "config/entity_registry/remove" body {"entity_id":"sensor.x"} — delete one orphaned entity.
- "config/device_registry/list" ; "config/area_registry/list".

## truenas  (JSON-RPC 2.0; path = method, body = the POSITIONAL PARAMS ARRAY — not an object)
- The body MUST be the params array. Query methods take a FILTERS LIST as the first param: body \`[[]]\` = all rows; \`[[["name","=","datapool"]]]\` = filtered; an options dict can be the 2nd element: \`[[], {"extra": {...}}]\`. Passing an object like \`{"id":1}\` FAILS with -32602 "filters: Input should be a valid list".
- Reads: pool.query (body \`[[]]\`), pool.dataset.query (body \`[[]]\`), disk.temperatures (body \`[]\`), system.info (body \`[]\`), app.query. Acts: app.start/app.stop, replication.run, pool.scrub.update (takes \`[id, {data}]\`).
- A -32601 "Method does not exist" means the method NAME is wrong (you guessed) — don't retry the same name; inspect with a known method or correct the name.

## jellyfin  (REST)
- GET /System/Info , GET /Sessions , GET /Items?... , POST /Items/{id}/...

## cloudflare  (REST, /client/v4)
- GET /client/v4/zones?name={domain} → zone id ; GET /client/v4/zones/{zone}/dns_records?name={fqdn}
- POST .../dns_records  body {"type":"A"|"CNAME"|…,"name":"{fqdn}","content":"{target}","proxied":true,"ttl":1} ; PATCH/DELETE .../dns_records/{id}
- Reads use a read-only token; WRITES use a separate write token and can be switched off by the owner (the result says so). A 403 on a write = the write token lacks that permission (name it, e.g. Zone → DNS → Edit).

## coolify  (REST, /api/v1 — auto-prefixed; Bearer token)
- Discover: GET /servers , GET /projects (→ project uuid + environments) , GET /applications , GET /applications/{uuid}
- Deploy / lifecycle: GET /deploy?uuid={app_uuid}&force=false ; GET /applications/{uuid}/start|stop|restart ; GET /deployments , GET /deployments/{deployment_uuid} (status + logs)
- Create from git: POST /applications/public (public repo) or /applications/private-github-app (with github_app_uuid; GET /github-apps lists them) — body needs project_uuid, server_uuid, environment_name, git_repository, git_branch, build_pack ("nixpacks"|"dockerfile"|"static"…), ports_exposes, and domains.
- Update: PATCH /applications/{uuid} (e.g. domains, build settings) ; env vars: GET/POST/PATCH /applications/{uuid}/envs
- A 401/403 usually means API access is off in Coolify or the token lacks the scope (read/write/deploy/root).

## npm  (Nginx Proxy Manager REST, /api — auto-prefixed; the server logs in and renews the session)
- GET /nginx/proxy-hosts?expand=certificate,access_list ; GET /nginx/certificates ; GET /nginx/access-lists
- POST /nginx/proxy-hosts body {"domain_names":["{fqdn}"],"forward_scheme":"http"|"https","forward_host":"{ip}","forward_port":{port},"certificate_id":{id}|0,"ssl_forced":true,"http2_support":true,"block_exploits":true,"allow_websocket_upgrade":true,"access_list_id":0,"meta":{},"advanced_config":"","locations":[]} ; PUT/DELETE /nginx/proxy-hosts/{id}
- Certificates: reuse an existing wildcard (certificate_id) when one covers the name; else POST /nginx/certificates {"provider":"letsencrypt","domain_names":[…],"meta":{…}}.
- If the proxy runs as an HA pair, make changes on the PRIMARY (the memory says which) — the standby follows by replication.
- The edge backends can be switched off by the owner; a disabled one refuses with a message saying so.`;

const SSH = `# run_shell — shell access over SSH

When the REST APIs can't do it (exec in a guest, read logs, inspect a file), run a command over SSH. It lands on the configured entry host by default; on a multi-node cluster pass run_shell's \`host\` to the node that owns the guest so you reach it directly — that's a parameter, not a default to work around.

\`pct exec\` only reaches containers on the SAME node it runs on — it is NOT cluster-wide. So a guest on another node fails on the entry node; you must run on the OWNING node. Pass that node's NAME as run_shell \`host\` (the server maps a Proxmox node name to its address — a node's short hostname usually doesn't resolve from here, so DON'T pass a bare name to ssh inside a command; let \`host\` do it). An IP also works.

From the node that owns it you can reach its local guests:
- pct exec {vmid} -- {command}        # run a command inside an LXC container ON THAT node
- pct exec {vmid} -- journalctl -u {service} -n 50 --no-pager
- qm guest exec {vmid} --             # for QEMU VMs (needs qemu-guest-agent)
- cat /etc/pve/... , journalctl ... , systemctl status {service}

Rules:
- A guest only exists on ITS node. Get the owning node + real vmid from GET /cluster/resources (or your lab map), then set run_shell \`host\` to that node name — don't default to the entry node, don't ssh-hop as a workaround.
- run_shell confirms in agent "all" mode and, in "critical" mode, ONLY when the command is destructive (deletes/overwrites files, or stops/destroys/reconfigures a service or guest). Read-only commands (zpool status, zdb, grep, journalctl, du…) auto-run in "critical" mode.
- Prefer the proper API first: e.g. HA registry edits go through lab_request homeassistant WebSocket commands (the server has the token), NOT by shelling into the HA container.
- Keep commands read-only unless the task is explicitly to change something. Report exit code + output.
- If SSH is not configured, tell the operator to add it in Settings; do not guess.`;

const MEMORY = `# The lab map (global memory discipline)

The lab's topology is NOT hardcoded — it lives in your global memory so it works for any deployment and survives the owner changing things. Maintain it:
- First time you need the topology in a session, recall it from memory. If there is NO lab-map note, BUILD one: GET /cluster/resources, then save a save_memory note mapping each guest → vmid/node/type (e.g. "lab map: <name>=<vmid>/<node>/<type>, …; trust cluster/resources over snapshot vmids").
- Treat the map as possibly stale. If a call 404s/contradicts it, re-read /cluster/resources, act on the truth, and UPDATE the memory note. Mention you refreshed it.
- save_memory is ONLY for durable lab facts like this map and quirks ("X is a community LXC"). NEVER store a one-off chat task there.`;

const DOCS: Record<ReferenceTopic, string> = { apis: APIS, ssh: SSH, memory: MEMORY };

export function readReference(topic: string): string {
  if ((REFERENCE_TOPICS as readonly string[]).includes(topic)) return DOCS[topic as ReferenceTopic];
  return `Unknown topic. Available: ${REFERENCE_TOPICS.join(', ')}.`;
}
