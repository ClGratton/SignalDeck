---
name: homelab
description: Operate the homelab managed by the Grtlabs dashboard — Proxmox VMs/containers, TrueNAS pools and apps, Home Assistant devices, Jellyfin, Cloudflare DNS, and SSH into lab hosts (pct exec, journalctl) — and keep its shared lab memory. Use for ANY question or task about the lab's state, services, guests, storage, smart-home entities, media server, or logs.
allowed-tools: mcp__plugin_grtlabs_lab__get_console_snapshot mcp__plugin_grtlabs_lab__lab_get mcp__plugin_grtlabs_lab__list_ha_entities mcp__plugin_grtlabs_lab__get_service_history mcp__plugin_grtlabs_lab__get_traffic mcp__plugin_grtlabs_lab__read_reference mcp__plugin_grtlabs_lab__list_memory mcp__plugin_grtlabs_lab__save_memory mcp__plugin_grtlabs_lab__update_memory mcp__plugin_grtlabs_lab__forget_memory
---

# Homelab (Grtlabs)

The `lab` MCP server gives you direct access to the lab through the Grtlabs
dashboard. The dashboard holds every backend credential and makes the calls; you
never see or need a key. **Calls run immediately. There is no confirmation on the
server**, so your own permission mode is the only approval. Be deliberate with
anything that changes state.

The server's instructions (in your context since session start) include the
**shared lab memory**: the lab map (guest → vmid / node / type) and known quirks.
The dashboard's own assistant reads and writes the same notes, so keep them
accurate for both of you.

## Tools

Read (pre-approved while this skill is active):
- `get_console_snapshot`: whole-lab state. Nodes, every VM/CT (name, vmid, node, status, load), pools / datasets / disk temps, Jellyfin sessions, and a preview of the Home Assistant entities. Pass `fresh: true` to bypass the ~10 s cache.
- `lab_get`: any READ on any backend (`service`: proxmox | homeassistant | truenas | jellyfin | cloudflare). It refuses writes.
- `list_ha_entities`: the full Home Assistant registry with states, filtered by `domain` and/or `query`.
- `get_service_history`: uptime history. `get_traffic`: Cloudflare request rates.
- `read_reference`: the manual. `"apis"` is the endpoint cheatsheet per backend, `"ssh"` covers pct exec and the multi-node rules, `"memory"` covers maintaining the lab map.
- `list_memory`: every memory note, including any the instructions had no room for.

Memory (pre-approved): `save_memory`, `update_memory`, `forget_memory`.

Change things (your permission mode decides):
- `lab_request`: any call, including POST / PUT / DELETE and TrueNAS or Home Assistant WebSocket actions.
- `run_shell`: an SSH command on a lab host. Set `host` to the NAME of the node that owns the guest.
- `guest_power`: start / shutdown / stop / reboot a VM or CT.
- `ha_service`: call a Home Assistant service on one entity.

## How to work

1. **Orient.** Start from the memory in your instructions, then `get_console_snapshot`. For vmid / node / type, `lab_get proxmox GET /cluster/resources` is the source of truth; snapshot vmids can be stale. If there is no lab map yet, build it from that call and `save_memory` it.
2. **Read the manual before a backend you haven't used this session**: `read_reference("apis")`, plus `read_reference("ssh")` before shelling into guests. The non-obvious parts:
   - a TrueNAS body is the positional params ARRAY (`[[]]` means all rows);
   - Home Assistant registry edits are WebSocket commands (a path with no leading slash, e.g. `config/entity_registry/list`);
   - `pct exec` only works on the node that owns the guest.
3. **Read with `lab_get`, act with `lab_request`.** Keep that split: it is what lets the permission prompt tell a read from a write.
4. **Discovery before denial.** Never say smart-home data doesn't exist until you have searched `list_ha_entities` with several terms, in both the lab's language and English (e.g. power / energy / consumo, temperature / temperatura).
5. **Before a restart, check who is using it.** For example, check the Jellyfin sessions in the snapshot. If someone is watching or listening, ask the operator first.
6. **Back up small config/state files before editing them**, and say where the backup is.
7. **Verify after acting.** Re-read the state (`fresh: true`) and report the real result: the HTTP status, RPC result or command output. Never report an assumed one.
8. **Auth limits are limits.** A 403 means the dashboard's agent credential lacks that permission: name the role or scope to grant. On a 401, stop and report it. Never try to extract, forge or recover tokens from internal files.
9. **Memory discipline.** Save only durable lab facts (topology, quirks, discovered entity ids), one per note, under 300 characters. Never save secrets or details of the current task; those stay in your own session. When a note turns out wrong, fix it with `update_memory` or remove it with `forget_memory`.

Output over ~4000 characters is truncated server-side. Narrow the query instead: filters, specific endpoints, `| tail`.
