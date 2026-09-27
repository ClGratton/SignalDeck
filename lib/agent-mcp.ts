// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the lab tools exposed to EXTERNAL agents (Claude Code / Codex on
// the owner's desktops) over the LAN-only MCP endpoint (app/api/agent/mcp).
//
// Deliberately NOT the dashboard assistant's harness: no chat, no task runner,
// no proposal/confirm cards, no model. Those agents bring their own context,
// caching and approvals (Claude Code's ask/auto modes, Codex's approval policy),
// so here each tool is just the raw lab function. The owner chose this
// explicitly (2026-09-27): agent tokens may do EVERYTHING the configured agent
// credentials permit, with no dashboard approval or TOTP re-auth. The MCP
// annotations (readOnlyHint / destructiveHint) are what lets the client's own
// permission layer tell reads from writes — which is also why reads and writes
// are separate tools (lab_get vs lab_request).
//
// Tool names mirror the dashboard assistant's so lib/assistant/reference.ts
// (served by read_reference) reads correctly for both.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import {
  getConsoleSnapshot,
  haCallService,
  labRequest,
  labBackendStatus,
  proxmoxGuestPower,
  LAB_SERVICES,
  type GuestPowerAction,
  type LabService,
} from '@/lib/console';
import { LAB_METHODS, type LabMethod } from '@/lib/homelab';
import { getTrafficSeries } from '@/lib/cloudflare';
import { sshConfigured, sshRun } from '@/lib/ssh';
import { addMemory, deleteMemory, listMemories, updateMemory } from '@/lib/assistant/memory';
import { readReference, REFERENCE_TOPICS } from '@/lib/assistant/reference';
import {
  haEntitiesText,
  isReadOnlyLabRequest,
  resolveShellHost,
  serviceHistoryText,
} from '@/lib/assistant/tools';

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const LAB_REQUEST_PROPS = {
  service: { type: 'string', enum: [...LAB_SERVICES] },
  method: {
    type: 'string',
    enum: [...LAB_METHODS],
    description: 'HTTP verb. For truenas (JSON-RPC) use GET for reads, POST for calls.',
  },
  path: {
    type: 'string',
    description:
      'Endpoint for the service (proxmox: under /api2/json; homeassistant: "/api/..." REST, or a WebSocket command type with NO leading slash e.g. "config/entity_registry/list"; cloudflare: /client/v4/...; coolify: /api/v1/... e.g. /applications; npm (Nginx Proxy Manager): /api/... e.g. /nginx/proxy-hosts), or the JSON-RPC method name for truenas.',
  },
  body: {
    description:
      'Optional payload: form params object (proxmox), JSON body (homeassistant/jellyfin/cloudflare/coolify/npm), or the positional params ARRAY for truenas (e.g. [[]] for a query).',
  },
};

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'get_console_snapshot',
    title: 'Lab snapshot',
    description:
      'Live snapshot of the whole homelab: Proxmox nodes and every VM/container (name, vmid, node, status, cpu, mem, uptime), TrueNAS pools/datasets/disk temps, Jellyfin sessions, curated Home Assistant entities. Start here for "what is the current state" questions.',
    inputSchema: {
      type: 'object',
      properties: { fresh: { type: 'boolean', description: 'Bypass the ~10s cache and probe live.' } },
    },
    annotations: READ,
  },
  {
    name: 'lab_get',
    title: 'Lab API read',
    description:
      'READ-ONLY call to any lab backend API (Proxmox, Home Assistant, TrueNAS, Jellyfin, Cloudflare). The server supplies base URL + auth. Refuses anything that is not a read (non-GET, or a TrueNAS/HA-WebSocket method that is not a query/get/list) — use lab_request for those. Call read_reference("apis") for the endpoint cheatsheet.',
    inputSchema: { type: 'object', properties: LAB_REQUEST_PROPS, required: ['service', 'method', 'path'] },
    annotations: { ...READ, idempotentHint: true },
  },
  {
    name: 'lab_request',
    title: 'Lab API call (read/write)',
    description:
      'Any call to any lab backend API, INCLUDING writes and deletes (e.g. proxmox DELETE /nodes/{node}/lxc/{vmid} destroys a container; truenas "app.stop"; homeassistant "config/entity_registry/remove"). Executes immediately with the lab agent credentials — there is no second confirmation on the server. Prefer lab_get for reads.',
    inputSchema: { type: 'object', properties: LAB_REQUEST_PROPS, required: ['service', 'method', 'path'] },
    annotations: WRITE,
  },
  {
    name: 'run_shell',
    title: 'Lab shell (SSH)',
    description:
      'Run a shell command over SSH on a lab host (default: the configured entry Proxmox node). For what no API does: pct exec {vmid} -- …, journalctl, config files. A guest lives only on its own node — pass that node NAME as `host` (resolved server-side to its IP). Executes immediately; there is no second confirmation on the server. Call read_reference("ssh") for patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command.' },
        host: { type: 'string', description: 'Optional node name or IP to run on.' },
      },
      required: ['command'],
    },
    annotations: { ...WRITE, openWorldHint: false },
  },
  {
    name: 'guest_power',
    title: 'Guest power',
    description:
      'Start / shutdown / stop / reboot a Proxmox VM (qemu) or container (lxc). Prefer "shutdown" (graceful) over "stop" (hard kill). Executes immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        type: { type: 'string', enum: ['qemu', 'lxc'] },
        vmid: { type: 'integer' },
        action: { type: 'string', enum: ['start', 'shutdown', 'stop', 'reboot'] },
      },
      required: ['node', 'type', 'vmid', 'action'],
    },
    annotations: WRITE,
  },
  {
    name: 'list_ha_entities',
    title: 'Home Assistant entities',
    description:
      'The FULL Home Assistant entity registry with current states (the snapshot only previews a few). Filter by `domain` ("light", "sensor"…) and/or `query` (substring of id or friendly name; names may be in the lab\'s local language — try synonyms).',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string' }, query: { type: 'string' } },
    },
    annotations: READ,
  },
  {
    name: 'ha_service',
    title: 'Home Assistant service',
    description:
      'Call a Home Assistant service on one entity (light.turn_off, switch.turn_on, lock.lock, …). For anything else use lab_request with service "homeassistant". Executes immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        service: { type: 'string' },
        entity_id: { type: 'string' },
      },
      required: ['domain', 'service', 'entity_id'],
    },
    annotations: WRITE,
  },
  {
    name: 'get_service_history',
    title: 'Service uptime history',
    description: 'Recorded daily health (ok / partial / down) per service for one month (month 1-12).',
    inputSchema: {
      type: 'object',
      properties: { year: { type: 'integer' }, month: { type: 'integer' } },
    },
    annotations: READ,
  },
  {
    name: 'get_traffic',
    title: 'Public traffic',
    description: 'Recent Cloudflare request rates (last ~30 min) and the busiest public hostnames.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
  },
  {
    name: 'read_reference',
    title: 'Lab API reference',
    description:
      'The lab API / SSH / lab-map reference manual. Topics: "apis" (per-service endpoint cheatsheet), "ssh" (pct exec, multi-node rules), "memory" (maintaining the shared lab map). Read before using a backend for the first time in a session.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', enum: [...REFERENCE_TOPICS] } },
      required: ['topic'],
    },
    annotations: READ,
  },
  {
    name: 'list_memory',
    title: 'Lab memory',
    description:
      'The shared, durable lab memory (also used by the dashboard assistant): the lab map (guest → vmid/node/type) and known quirks. Read this before acting on guests; treat it as possibly stale.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
  },
  {
    name: 'save_memory',
    title: 'Save lab memory',
    description:
      'Add ONE durable lab fact to the shared memory (lab map, quirks), under 300 chars. Never one-off task details, never secrets.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'update_memory',
    title: 'Correct lab memory',
    description: 'Correct a stale/wrong memory note in place. `id` is the note id from list_memory.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, text: { type: 'string' } },
      required: ['id', 'text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: 'forget_memory',
    title: 'Delete lab memory',
    description: 'Delete a memory note that is wrong or obsolete. `id` from list_memory.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

// MCP clients put the server's `instructions` into the agent's context at
// session start (Claude Code caps them at ~2 KB). That is where the SHARED LAB
// MEMORY goes — the same notes the dashboard assistant gets in its prompt — so
// an external agent starts out knowing the lab map and quirks without a call.
// Whatever doesn't fit is one list_memory away.
const INSTRUCTIONS_BUDGET = 2000;
const INSTRUCTIONS_BASE =
  'Direct access to this homelab (Proxmox, TrueNAS, Home Assistant, Jellyfin, Cloudflare, Coolify, Nginx Proxy Manager, SSH) through the Grtlabs dashboard, which holds the credentials. ' +
  'Calls execute immediately — there is no confirmation on the server; your own permission mode is the approval. ' +
  'Read with lab_get, act with lab_request / run_shell / guest_power / ha_service; read_reference("apis"|"ssh"|"memory") before an unfamiliar backend. ' +
  'The lab memory below is shared with the dashboard assistant: trust it until reality contradicts it, then fix it (update_memory / forget_memory); save durable lab facts only (save_memory).';

export function mcpInstructions(): string {
  const head = `${INSTRUCTIONS_BASE}\n\n${labBackendStatus()}`;
  const notes = listMemories();
  if (notes.length === 0) {
    return `${head}\n\nLab memory is empty — build the lab map from lab_get proxmox GET /cluster/resources and save it (read_reference("memory")).`;
  }
  let out = `${head}\n\nLab memory ([id] for update_memory/forget_memory):`;
  let shown = 0;
  for (const n of notes) {
    const line = `\n- [${n.id.slice(0, 8)}] ${n.text}`;
    if (out.length + line.length > INSTRUCTIONS_BUDGET - 60) break;
    out += line;
    shown++;
  }
  if (shown < notes.length) out += `\n(${notes.length - shown} more — call list_memory.)`;
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const text =(t: string, isError = false): McpToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
});
const outcome = (r: { ok: boolean; detail: string }) => text(r.detail, !r.ok);

/** Human-readable "what was requested" for the audit log (no secrets: the tools
 *  never take credentials). */
export function describeCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'lab_get':
    case 'lab_request':
      return `${str(args.service)} ${str(args.method).toUpperCase()} ${str(args.path)}${
        args.body !== undefined ? ' ' + JSON.stringify(args.body).slice(0, 160) : ''
      }`;
    case 'run_shell':
      return `${str(args.host) ? `@${str(args.host)}: ` : ''}${str(args.command)}`;
    case 'guest_power':
      return `${str(args.action)} ${str(args.type)}/${String(args.vmid)} on ${str(args.node)}`;
    case 'ha_service':
      return `${str(args.domain)}.${str(args.service)} → ${str(args.entity_id)}`;
    default:
      return JSON.stringify(args).slice(0, 160);
  }
}

export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  switch (name) {
    case 'get_console_snapshot':
      return text(JSON.stringify(await getConsoleSnapshot({ fresh: args.fresh === true })));

    case 'lab_get':
    case 'lab_request': {
      const service = str(args.service) as LabService;
      const method = str(args.method).toUpperCase();
      const path = str(args.path);
      if (!LAB_SERVICES.includes(service) || !(LAB_METHODS as string[]).includes(method) || !path) {
        return text('Invalid arguments (service, method, path required).', true);
      }
      if (name === 'lab_get' && !isReadOnlyLabRequest(service, method, path)) {
        return text('lab_get only performs reads. Use lab_request for writes/actions.', true);
      }
      return outcome(await labRequest(service, method as LabMethod, path, args.body));
    }

    case 'run_shell': {
      const command = str(args.command);
      if (!command) return text('command is required.', true);
      if (!sshConfigured()) return text('SSH is not configured on the dashboard (Settings → SSH).', true);
      return outcome(await sshRun(command, await resolveShellHost(str(args.host))));
    }

    case 'guest_power': {
      const node = str(args.node);
      const type = str(args.type);
      const vmid = typeof args.vmid === 'number' && Number.isInteger(args.vmid) ? args.vmid : NaN;
      const action = str(args.action);
      if (!node || !['qemu', 'lxc'].includes(type) || Number.isNaN(vmid) || !['start', 'shutdown', 'stop', 'reboot'].includes(action)) {
        return text('Invalid guest_power arguments.', true);
      }
      return outcome(await proxmoxGuestPower(node, type as 'qemu' | 'lxc', vmid, action as GuestPowerAction));
    }

    case 'list_ha_entities': {
      const out = await haEntitiesText(str(args.domain), str(args.query));
      return out == null ? text('Home Assistant is not configured or unreachable.', true) : text(out);
    }

    case 'ha_service':
      return outcome(await haCallService(str(args.domain), str(args.service), str(args.entity_id)));

    case 'get_service_history': {
      const out = serviceHistoryText(args.year, args.month);
      return out == null ? text('Invalid year/month.', true) : text(out);
    }

    case 'get_traffic': {
      const series = await getTrafficSeries();
      return text(series ? JSON.stringify(series) : 'Traffic integration is off (no Cloudflare credentials).');
    }

    case 'read_reference':
      return text(readReference(str(args.topic)));

    case 'list_memory': {
      const notes = listMemories();
      return text(notes.length ? notes.map((n) => `[${n.id.slice(0, 8)}] ${n.text}`).join('\n') : 'Memory is empty.');
    }

    case 'save_memory':
      return outcome(addMemory(str(args.text)));

    case 'update_memory':
      return outcome(updateMemory(str(args.id), str(args.text)));

    case 'forget_memory': {
      const ok = deleteMemory(str(args.id));
      return text(ok ? 'Memory note deleted.' : 'No memory note matched that id.', !ok);
    }

    default:
      return text(`Unknown tool: ${name}`, true);
  }
}
