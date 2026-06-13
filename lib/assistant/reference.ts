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

## truenas  (JSON-RPC 2.0; path = method, body = params array)
- pool.query , pool.dataset.query , disk.temperatures , app.query/app.start/app.stop , replication.run

## jellyfin  (REST)
- GET /System/Info , GET /Sessions , GET /Items?... , POST /Items/{id}/...

## cloudflare  (REST, /client/v4)
- GET /client/v4/zones/{zone}/dns_records , PATCH .../dns_records/{id}`;

const SSH = `# run_shell — shell access over SSH

When the REST APIs can't do it (exec in a guest, read logs, inspect a file), run a command over SSH. It lands on the configured entry host by default; on a multi-node cluster pass run_shell's \`host\` to the node that owns the guest so you reach it directly — that's a parameter, not a default to work around.

From a Proxmox node you can reach its local containers:
- pct exec {vmid} -- {command}        # run a command inside an LXC container ON THAT node
- pct exec {vmid} -- journalctl -u {service} -n 50 --no-pager
- qm guest exec {vmid} --             # for QEMU VMs (needs qemu-guest-agent)
- cat /etc/pve/... , journalctl ... , systemctl status {service}

Rules:
- A guest only exists on ITS node. Get the owning node + real vmid from GET /cluster/resources, then set run_shell \`host\` to that node — don't assume one node, don't ssh-hop as a workaround.
- run_shell is ALWAYS a critical action (it can do anything) — it confirms in agent "all"/"critical" modes.
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
