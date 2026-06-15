// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the assistant's tool surface over the homelab.
//
// The model has DIRECT, full API access to every backend through one generic
// tool (lab_request), plus a couple of convenience wrappers. How an action runs
// depends
// on the turn context:
//   • Ask mode    → register an out-of-band proposal card (the propose pipeline).
//   • Agent mode  → execute INLINE and let the loop continue; pause for an inline
//                   Run/Skip only when the approval level requires it (every
//                   action, or just critical ones), then resume automatically.
//
// Tool descriptions are deliberately prescriptive ("call this when…") — recent
// models under-reach for tools unless the trigger condition is in the
// description itself.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  getConsoleSnapshot,
  haListStates,
  proxmoxGuestPower,
  haCallService,
  labRequest,
  LAB_SERVICES,
  type GuestPowerAction,
  type LabService,
} from '@/lib/console';
import { getTrafficSeries } from '@/lib/cloudflare';
import { getHistoryRecord } from '@/lib/history-store';
import { buildServiceHistories } from '@/lib/history';
import { sshRun, sshConfigured } from '@/lib/ssh';
import { addProposal } from '@/lib/assistant/proposals';
import { addMemory, updateMemory, deleteMemory } from '@/lib/assistant/memory';
import { addChatNote, setPlan, updatePlanStep } from '@/lib/assistant/chat-workspace';
import { isElevated } from '@/lib/reauth';
import { markReauthRequired } from '@/lib/assistant/decisions';
import { readReference, REFERENCE_TOPICS } from '@/lib/assistant/reference';
import type {
  AssistantEvent,
  AssistantMode,
  ApprovalLevel,
  ProposalCard,
} from '@/lib/assistant/types';

/** Provider-neutral tool definition (Anthropic uses it as-is; Gemini maps it). */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolOutcome {
  /** Text fed back to the model as the tool result. */
  content: string;
  isError?: boolean;
}

/** Per-turn context threaded into executeTool so action dispatch can stream
 *  events and (in agent mode) await an inline decision. */
export interface ToolContext {
  mode: AssistantMode;
  approval: ApprovalLevel;
  emit: (e: AssistantEvent) => void;
  /** Await the operator's Run/Skip for one action (agent mode confirm path). */
  awaitDecision: (id: string, signal?: AbortSignal) => Promise<'run' | 'skip'>;
  signal?: AbortSignal;
  /** Active chat id — scopes the per-chat workspace (notes + plan) tools. */
  chatId?: string;
}

/** A concrete action the model asked for, ready to dispatch. */
interface ActionSpec {
  title: string;
  detail: string;
  /** Destructive / irreversible — confirmed in "critical" approval mode. */
  critical: boolean;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const READ_TOOLS: ToolDef[] = [
  {
    name: 'get_console_snapshot',
    description:
      'The live operator snapshot of the whole homelab: Proxmox node load/memory and every VM/container (name, vmid, node, status, cpu, memory, uptime), TrueNAS pools/datasets/disk temperatures, Jellyfin playback sessions, and the curated Home Assistant entities. Call this FIRST for any question about current state — what is running, resource usage, storage, who is watching, temperatures.',
    input_schema: {
      type: 'object',
      properties: {
        fresh: {
          type: 'boolean',
          description:
            'Bypass the ~10s cache and probe the backends live. Use when the operator disputes your data or right after a confirmed action.',
        },
      },
    },
  },
  {
    name: 'save_memory',
    description:
      'Save a short durable note to the operator-visible memory (listed in the sidebar, injected into every future chat). Call this when the operator corrects you or states a lasting fact about the lab — e.g. "jellyfin is a community LXC, backend differs from the official image". One fact per note, under 300 characters. NEVER store secrets, keys, or tokens.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note to remember, one concise fact.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'update_memory',
    description:
      'Correct a durable memory note in place when you find it is WRONG or STALE (e.g. a guest moved nodes, a vmid changed). Pass the note id shown in brackets before each note in your memory, and the corrected text. Keep memory accurate — do not leave a known-wrong note sitting there.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id shown in [brackets] before the note.' },
        text: { type: 'string', description: 'The corrected note text.' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'forget_memory',
    description:
      'Delete a durable memory note that is no longer true or never should have been saved. Pass the note id shown in brackets before it. Use this to keep global memory clean — but only for genuinely wrong/obsolete facts, not to clear correct ones.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id shown in [brackets] before the note.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_ha_entities',
    description:
      'The FULL Home Assistant entity registry (the snapshot only shows a curated preview of it). Call this BEFORE ever saying some smart-home data does not exist, and to discover what exists before proposing ha_service. Filter with `domain` (e.g. "light", "sensor", "switch", "climate") and/or `query` (substring of the entity id or friendly name). Entity names may be in the lab\'s local language — try synonyms in both that language and English, and search multiple times with different terms if the first try comes up empty.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain filter, e.g. "light" or "sensor".' },
        query: {
          type: 'string',
          description: 'Case-insensitive substring matched against entity id and friendly name.',
        },
      },
    },
  },
  {
    name: 'get_service_history',
    description:
      'Recorded daily health history (ok / partial / down per day) for each service, one calendar month at a time. Call this for questions about past outages, uptime percentages, incident counts, or streaks. Months are 1-12.',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'integer', description: 'Four-digit year. Defaults to the current year.' },
        month: { type: 'integer', description: '1-12. Defaults to the current month.' },
      },
    },
  },
  {
    name: 'get_traffic',
    description:
      'Recent public web traffic through Cloudflare: requests per minute over the last ~30 minutes and the busiest hostnames with their rates. Call this for questions about site traffic, request volume, or which subdomain is busy.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'start_timer',
    description:
      'When the task needs to WAIT before the next step — a job/backup to finish, a service to restart and come back, a sync to settle, any "check again in a bit" — ESTIMATE how long (seconds) and call this INSTEAD of looping, sleeping, or guessing. It shows the operator a live countdown and ENDS your turn; you are automatically re-invoked when it elapses to check and continue. The operator can pause it to ask you something. Give a realistic ETA; if it still is not ready when you resume, set another timer. Do not call other tools after this in the same turn.',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: 'How long to wait, 1–3600 seconds.' },
        reason: {
          type: 'string',
          description: 'Short label shown on the countdown, e.g. "waiting for the gravity update to finish".',
        },
      },
      required: ['seconds', 'reason'],
    },
  },
  {
    name: 'read_reference',
    description:
      'Look up the detailed reference manual (kept out of your always-on context to save tokens). Call before working with a backend you have not used this session, or when unsure. Topics: "apis" (per-service lab_request endpoint cheatsheet), "ssh" (run_shell usage, pct exec etc.), "memory" (how to maintain the lab topology map in global memory).',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: [...REFERENCE_TOPICS] },
      },
      required: ['topic'],
    },
  },
  {
    name: 'note_to_self',
    description:
      'Save a short note scoped to THIS chat only (operator-visible in the chat). Use for facts/intent that matter just for the current conversation — the task you are mid-way through, an id you are tracking for it, a "remember to do X next". This is NOT global memory: do not put lasting lab facts here (use save_memory) and do not put one-off task details in save_memory. One concise note, under 300 characters. Never store secrets.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The chat-scoped note, one concise line.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'plan_set',
    description:
      'Lay out (or REPLACE) a step-by-step plan/checklist for the CURRENT task — shown to the operator and tracked as you work. Call this ONLY at the start of a genuinely LONG, multi-step request (a migration, a multi-service change, a methodical investigation), then mark progress with plan_update. Do NOT make a plan for simple one- or two-step requests. Pass the ordered steps; they all start unchecked. Call again to revise the plan as you learn more.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered short step descriptions. Empty array clears the plan.',
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'plan_update',
    description:
      'Update one step of the current plan as you work it: set it "doing" when you start and "done" when it lands (or back to "todo"). Identify the step by its 1-based number or the [id] shown next to it in the plan. Keep the checklist honest so the operator can follow along.',
    input_schema: {
      type: 'object',
      properties: {
        step: { type: 'string', description: 'The step\'s 1-based number, or its [id] from the plan.' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'] },
      },
      required: ['step', 'status'],
    },
  },
];

const ACTION_TOOLS: ToolDef[] = [
  {
    name: 'guest_power',
    description:
      'Power a Proxmox VM or container (start / shutdown / stop / reboot). Convenience wrapper over the Proxmox API. Use the vmid/node/type exactly as reported by get_console_snapshot. Prefer "shutdown" (graceful) over "stop" (hard kill) unless the guest is unresponsive. How it runs depends on the mode (executes directly in agent mode; you may be asked to confirm) — just call it; the system handles approval and tells you the real result.',
    input_schema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Proxmox node name from the snapshot.' },
        type: { type: 'string', enum: ['qemu', 'lxc'], description: 'qemu = VM, lxc = container.' },
        vmid: { type: 'integer', description: 'Guest vmid from the snapshot.' },
        action: { type: 'string', enum: ['start', 'shutdown', 'stop', 'reboot'] },
        guest_name: { type: 'string', description: 'Guest name, for the action card.' },
      },
      required: ['node', 'type', 'vmid', 'action'],
    },
  },
  {
    name: 'ha_service',
    description:
      'Call a Home Assistant service on one entity (e.g. light.turn_off on light.office, switch.turn_on, climate.set_temperature, lock.lock, cover.open_cover). Convenience wrapper; for anything services do not cover use lab_request with service "homeassistant". Use entity ids exactly as returned by list_ha_entities or the snapshot. The system handles approval and returns the real result — act on it.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Service domain, e.g. "light", "switch", "lock".' },
        service: { type: 'string', description: 'Service name, e.g. "turn_on", "turn_off".' },
        entity_id: { type: 'string', description: 'Target entity id, e.g. "light.office".' },
      },
      required: ['domain', 'service', 'entity_id'],
    },
  },
  {
    name: 'lab_request',
    description:
      'Your UNIVERSAL hands: make a direct call to ANY of the lab\'s backend APIs. Pick the `service` and the server handles that backend\'s base URL, auth, and transport — you just reason about the endpoint. This is how you do anything the convenience tools (guest_power, ha_service) do not cover. You are expected to know these APIs; explore with reads (GET / .query) first, then act.\n' +
      '- service "proxmox": Proxmox VE REST under /api2/json. e.g. DELETE /nodes/{node}/lxc/{vmid} destroys a container; POST .../config reconfigures; GET .../tasks reads history. `body` = form params.\n' +
      '- service "homeassistant": a path STARTING WITH "/" is REST under /api/ (e.g. GET /api/error_log; GET /api/config/config_entries; GET /api/history/period/{ts}). A path WITHOUT a leading slash is a WebSocket command type — the ONLY way to touch the entity/device registry. e.g. path "config/entity_registry/remove" body {"entity_id":"sensor.x"} removes one orphaned entity; "config/entity_registry/list", "config/device_registry/remove_config_entry". The server calls HA directly with its own token — never shell into the HA container to do this.\n' +
      '- service "truenas": TrueNAS SCALE JSON-RPC 2.0 (no REST). Put the RPC METHOD in `path` (e.g. "pool.dataset.query", "app.start", "replication.run") and its params array in `body`.\n' +
      '- service "jellyfin": Jellyfin REST. e.g. GET /Sessions, GET /System/Info, POST /Items/{id}/... `path` is the endpoint.\n' +
      '- service "cloudflare": Cloudflare REST under /client/v4 (auto-prefixed). e.g. GET /client/v4/zones/{zone}/dns_records.\n' +
      'The system applies the operator\'s approval and returns the REAL result (HTTP status / RPC result, or 403 when the token lacks permission — then name the role/scope to grant).',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: [...LAB_SERVICES] },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
          description: 'HTTP verb. For truenas (JSON-RPC) this is ignored — use GET for reads, POST for calls.',
        },
        path: {
          type: 'string',
          description:
            'The endpoint for the chosen service, or the JSON-RPC method name for truenas.',
        },
        body: {
          type: 'object',
          description: 'Optional payload: form params (proxmox), JSON body (ha/jellyfin/cloudflare), or the params ARRAY for truenas.',
        },
        summary: {
          type: 'string',
          description: 'Short human summary for the action card, e.g. "Destroy the recipes container" or "Read Jellyfin system info".',
        },
      },
      required: ['service', 'method', 'path', 'summary'],
    },
  },
  {
    name: 'run_shell',
    description:
      'Run a shell command over SSH on a lab host — for what no REST API can do: exec inside a container (pct exec {vmid} -- ...), read logs (journalctl), inspect files, check services. By default it lands on the configured entry host; in a multi-node cluster set `host` to the node that actually owns the guest (get the node from GET /cluster/resources) so you reach it directly instead of hopping. Read-only commands auto-run in agent "critical" mode; only commands that delete/overwrite files or stop/destroy/reconfigure a service or guest pause for confirmation. Call read_reference("ssh") for the patterns. Keep commands read-only unless the task is to change something.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run on the host.' },
        host: {
          type: 'string',
          description: 'Optional: the cluster node hostname/IP to run on (same credentials). Use the node that owns the target guest. Omit for the default entry host.',
        },
        summary: { type: 'string', description: 'Short human summary for the action card.' },
      },
      required: ['command', 'summary'],
    },
  },
];

// Action tools are always offered; behaviour (propose vs execute) is decided by
// the turn context, not by hiding tools.
export function listTools(): ToolDef[] {
  return [...READ_TOOLS, ...ACTION_TOOLS];
}

/** Human label for the "used a tool" chip in the chat. */
export function toolLabel(name: string): string {
  switch (name) {
    case 'get_console_snapshot':
      return 'read lab snapshot';
    case 'save_memory':
      return 'saved a memory note';
    case 'update_memory':
      return 'corrected a memory note';
    case 'forget_memory':
      return 'deleted a memory note';
    case 'list_ha_entities':
      return 'listed HA entities';
    case 'get_service_history':
      return 'read service history';
    case 'get_traffic':
      return 'read traffic';
    case 'guest_power':
      return 'power action';
    case 'ha_service':
      return 'HA service call';
    case 'lab_request':
      return 'API call';
    case 'run_shell':
      return 'shell command';
    case 'read_reference':
      return 'read reference';
    case 'start_timer':
      return 'set a timer';
    case 'note_to_self':
      return 'noted for this chat';
    case 'plan_set':
      return 'made a plan';
    case 'plan_update':
      return 'updated the plan';
    default:
      return name;
  }
}

// Risk: destructive / irreversible actions are "critical" and get confirmed in
// the "critical only" approval mode. Safe, reversible actions auto-run there.
const HA_CRITICAL_DOMAINS = new Set(['lock', 'alarm_control_panel']);
// A lab_request is safe to auto-run only when it is clearly a READ.
const READONLY_RPC = /\.(query|get|info|config|list|read|status|test|validate)$|^system\.|^reporting\./i;
function labRequestCritical(service: LabService, method: string, path: string): boolean {
  if (service === 'truenas') return !READONLY_RPC.test(path.trim());
  return method !== 'GET'; // any write/delete to a REST backend
}

// run_shell can do anything, so we DENY-LIST the destructive shapes instead of
// trying to allow-list every safe one. A command confirms in "critical" mode
// ONLY when it deletes/overwrites files or stops/destroys/reconfigures a service
// or guest. Plain reads, pipes and inspections (zpool status, zdb, grep, du,
// journalctl…) auto-run — otherwise "critical" collapses into "confirm every".
// Errs toward confirming on ambiguous matches; misses are bounded by the deny-list.
const SHELL_CRITICAL: RegExp[] = [
  /\b(rm|rmdir|unlink|shred|srm)\b/i, // delete files
  /\b(dd|mkfs(\.\w+)?|wipefs|mkswap|parted|fdisk|sfdisk|sgdisk)\b/i, // wipe/format disks
  /\b(mv|cp|chown|chmod|chattr|ln|truncate|tee)\b/i, // move/overwrite/permissions
  /\bsed\b[^|]*\s-i/i, // in-place edit
  /-delete\b/i, // find … -delete
  /(?:^|[\s;&|])\d*>>?\s*(?!&)(?!\/dev\/null\b)["']?[~.\/a-zA-Z0-9_]/, // write/append to a file
  /\bzpool\s+(destroy|remove|offline|detach|replace|clear|add|create|split|labelclear)\b/i,
  /\bzfs\s+(destroy|rollback|rename|set|create|receive|recv|promote)\b/i,
  /\b(qm|pct)\s+(destroy|stop|reset|shutdown|suspend|rollback|set|delete|template|migrate|create)\b/i,
  /\bsystemctl\s+(stop|restart|disable|mask|kill|reload)\b/i,
  /\bservice\s+\S+\s+(stop|restart|reload)\b/i,
  /\b(reboot|shutdown|poweroff|halt|telinit)\b/i,
  /\b(kill|pkill|killall)\b/i,
  /\bapt(-get)?\s+(remove|purge|autoremove|install|upgrade|dist-upgrade)\b/i,
  /\b(yum|dnf)\s+(remove|erase|install|update|upgrade)\b/i,
  /\bpacman\s+-[RSU]/i,
  /\bdpkg\b[^|]*\s-[rPi]\b/i,
  /\bdocker(-compose)?\s+(rm|rmi|stop|kill|down|prune|restart|up)\b/i,
  /\b(useradd|userdel|usermod|groupadd|groupdel|passwd|chpasswd)\b/i,
  /\bcrontab\s+-r\b/i,
];
function shellCommandCritical(command: string): boolean {
  return SHELL_CRITICAL.some((re) => re.test(command));
}

// The DESTRUCTIVE BLACKLIST — a deliberately SMALL set of the most irreversible
// shapes that ALWAYS require a fresh re-auth (a 30-min elevation window),
// regardless of approval mode (a hard floor even in 'auto'). Matched on the
// action's detail string: HTTP DELETE, RPC .delete/.destroy, rm -rf, and disk
// wipe/format (mkfs/wipefs). Everything else keeps its normal mode/approval
// behavior. The list stays tight to avoid flagging benign reads: `format` is
// NOT a word here on purpose — it's the `--format` display flag far more often
// than a disk wipe, and real formatting is mkfs/wipefs anyway.
const HIGH_RISK = /\b(destroy|delete|wipe|mkfs|wipefs)\b|\brm\s+-\w*[rf]/i;
function isHighRiskAction(detail: string): boolean {
  return HIGH_RISK.test(detail);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : NaN);

/** Turn a requested action into a tool result, honoring the mode + approval:
 *  ask → propose card; agent → run inline, pausing for Run/Skip only when the
 *  approval level requires it. Streams confirm/action events to the UI. */
async function dispatchAction(spec: ActionSpec, ctx: ToolContext): Promise<ToolOutcome> {
  if (ctx.mode === 'ask') {
    const card = addProposal(spec.title, spec.detail, spec.run);
    ctx.emit({ type: 'proposal', proposal: card });
    return {
      content: `Proposed "${spec.title}". A confirmation card is waiting for the operator; it has NOT run. Do not claim it ran — summarize what you proposed and why.`,
    };
  }

  const id = randomUUID();
  const card: ProposalCard = {
    id,
    title: spec.title,
    detail: spec.detail,
    expiresAt: Date.now() + 5 * 60_000,
  };
  const skipped = (): ToolOutcome => {
    ctx.emit({ type: 'action', id, title: spec.title, status: 'skipped', request: spec.detail });
    return {
      content: `The operator did NOT authorize "${spec.title}" — it did NOT run. Do not retry it; carry on with the rest of the task and note it was skipped.`,
    };
  };
  const highRisk = isHighRiskAction(spec.detail);

  if (highRisk && !isElevated()) {
    // Destructive blacklist, no live elevation: REQUIRE a fresh re-auth (which
    // also serves as the confirmation). Success opens the 30-min window so a
    // batch of destructive actions only prompts once.
    markReauthRequired(id);
    ctx.emit({ type: 'reauth', card });
    const decision = await ctx.awaitDecision(id, ctx.signal);
    if (decision === 'skip') return skipped();
    // 'run' ⇒ /api/assistant/decide verified password + TOTP and opened the window.
  } else if (!highRisk) {
    // Normal flow: confirm per the approval level. (High-risk + already elevated
    // falls through and runs straight away — the window covers it.)
    const needsConfirm = ctx.approval === 'all' || (ctx.approval === 'critical' && spec.critical);
    if (needsConfirm) {
      ctx.emit({ type: 'confirm', card, critical: spec.critical });
      const decision = await ctx.awaitDecision(id, ctx.signal);
      if (decision === 'skip') return skipped();
    }
  }

  // `spec.detail` is what we're about to SEND (command / method+path+body); the
  // run() result is the OUTPUT. The card shows them as separate sections.
  ctx.emit({ type: 'action', id, title: spec.title, status: 'running', request: spec.detail });
  const res = await spec.run();
  ctx.emit({
    type: 'action',
    id,
    title: spec.title,
    status: res.ok ? 'ok' : 'fail',
    detail: res.detail,
    request: spec.detail,
  });
  return {
    content: res.ok ? `DONE — ${spec.title}: ${res.detail}` : `FAILED — ${spec.title}: ${res.detail}`,
    isError: !res.ok,
  };
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;

  switch (name) {
    case 'get_console_snapshot': {
      const snap = await getConsoleSnapshot({ fresh: args.fresh === true });
      const ha = snap.homeassistant;
      const note =
        ha && ha.online
          ? `\nNOTE: homeassistant.entities above is a curated PREVIEW (${ha.entities.length} of ${ha.totalEntities} entities). Do NOT conclude any smart-home data is missing from this — search the full registry with list_ha_entities first.`
          : '';
      return { content: JSON.stringify(snap) + note };
    }

    case 'save_memory': {
      const result = addMemory(str(args.text));
      return {
        content: result.ok
          ? 'Note saved to the operator-visible memory.'
          : `Could not save: ${result.detail}`,
        isError: !result.ok,
      };
    }

    case 'update_memory': {
      const result = updateMemory(str(args.id), str(args.text));
      return { content: result.ok ? 'Memory note corrected.' : `Could not update: ${result.detail}`, isError: !result.ok };
    }

    case 'forget_memory': {
      const ok = deleteMemory(str(args.id));
      return { content: ok ? 'Memory note deleted.' : 'No memory note matched that id.', isError: !ok };
    }

    case 'note_to_self': {
      if (!ctx.chatId) return { content: 'No chat context for a chat-scoped note.', isError: true };
      const res = addChatNote(ctx.chatId, str(args.text));
      if (res.ok) ctx.emit({ type: 'workspace', workspace: res.workspace });
      return { content: res.ok ? 'Noted for this chat.' : `Could not note: ${res.detail}`, isError: !res.ok };
    }

    case 'plan_set': {
      if (!ctx.chatId) return { content: 'No chat context for a plan.', isError: true };
      const steps = Array.isArray(args.steps) ? (args.steps as unknown[]).map((s) => str(s)) : [];
      const res = setPlan(ctx.chatId, steps);
      ctx.emit({ type: 'workspace', workspace: res.workspace });
      return { content: res.detail };
    }

    case 'plan_update': {
      if (!ctx.chatId) return { content: 'No chat context for a plan.', isError: true };
      const status = str(args.status);
      if (!['todo', 'doing', 'done'].includes(status)) {
        return { content: 'status must be todo, doing, or done.', isError: true };
      }
      const res = updatePlanStep(ctx.chatId, str(args.step), status as 'todo' | 'doing' | 'done');
      if (res.ok) ctx.emit({ type: 'workspace', workspace: res.workspace });
      return { content: res.detail, isError: !res.ok };
    }

    case 'list_ha_entities': {
      const states = await haListStates();
      if (!states) return { content: 'Home Assistant is not configured or unreachable.', isError: true };
      const domain = str(args.domain).toLowerCase();
      const query = str(args.query).toLowerCase();
      const rows = states
        .filter((s) => !domain || s.entity_id.startsWith(domain + '.'))
        .filter(
          (s) =>
            !query ||
            s.entity_id.toLowerCase().includes(query) ||
            (s.attributes?.friendly_name ?? '').toLowerCase().includes(query),
        )
        .slice(0, 300)
        .map((s) => {
          const unit = s.attributes?.unit_of_measurement;
          const friendly = s.attributes?.friendly_name;
          return `${s.entity_id} = ${s.state}${unit ? ' ' + unit : ''}${friendly ? `  (${friendly})` : ''}`;
        });
      return {
        content: rows.length > 0 ? rows.join('\n') : 'No entities matched.',
      };
    }

    case 'get_service_history': {
      const now = new Date();
      const year = Number.isInteger(args.year) ? (args.year as number) : now.getFullYear();
      const month1 = Number.isInteger(args.month) ? (args.month as number) : now.getMonth() + 1;
      if (year < 2020 || year > now.getFullYear() || month1 < 1 || month1 > 12) {
        return { content: 'Invalid year/month.', isError: true };
      }
      const today = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
      const histories = buildServiceHistories(year, month1 - 1, today, getHistoryRecord());
      const lines = histories.map((h) => {
        const days = h.days
          .filter((d) => d.level !== 'future')
          .map((d) => `${d.day}:${d.level}`)
          .join(' ');
        return `${h.label}: uptime ${h.uptimePct}% · ${h.incidents} incident day(s) · streak ${h.streakDays}d\n  ${days}`;
      });
      return { content: lines.join('\n') || 'No history recorded for that month.' };
    }

    case 'get_traffic': {
      const series = await getTrafficSeries();
      if (!series) return { content: 'Traffic integration is off (no Cloudflare credentials).' };
      return { content: JSON.stringify(series) };
    }

    case 'read_reference': {
      return { content: readReference(str(args.topic)) };
    }

    case 'start_timer': {
      let secs = int(args.seconds);
      if (Number.isNaN(secs)) secs = 0;
      secs = Math.min(Math.max(secs, 1), 3600);
      const reason = str(args.reason) || 'waiting';
      ctx.emit({ type: 'timer', id: randomUUID(), seconds: secs, label: reason });
      return {
        content: `Timer started: ${secs}s — ${reason}. END YOUR TURN now (no more tool calls). You will be re-invoked automatically when it elapses to continue, unless the operator pauses it to ask something.`,
      };
    }

    case 'run_shell': {
      const command = str(args.command);
      const host = str(args.host);
      const summary = str(args.summary) || command.slice(0, 60);
      if (!command) return { content: 'Invalid run_shell arguments (command required).', isError: true };
      if (!sshConfigured()) {
        return {
          content:
            'SSH is not configured. Tell the operator to add SSH host/user + password or key in Settings. Do not retry.',
          isError: true,
        };
      }
      return dispatchAction(
        {
          title: summary,
          detail: `SSH${host ? ` @${host}` : ''}: ${command}`,
          // Read-only commands auto-run in "critical" mode; only ones that
          // delete/overwrite files or stop/destroy a service or guest confirm.
          critical: shellCommandCritical(command),
          run: () => sshRun(command, host || undefined),
        },
        ctx,
      );
    }

    case 'guest_power': {
      const node = str(args.node);
      const type = str(args.type) as 'qemu' | 'lxc';
      const vmid = int(args.vmid);
      const action = str(args.action) as GuestPowerAction;
      if (!node || !['qemu', 'lxc'].includes(type) || Number.isNaN(vmid) || !['start', 'shutdown', 'stop', 'reboot'].includes(action)) {
        return { content: 'Invalid guest_power arguments.', isError: true };
      }
      const guestName = str(args.guest_name);
      return dispatchAction(
        {
          title: `${action} ${type} ${vmid}${guestName ? ` (${guestName})` : ''}`,
          detail: `Sends "${action}" to ${type}/${vmid} on node ${node} via the Proxmox API.`,
          critical: action !== 'start',
          run: () => proxmoxGuestPower(node, type, vmid, action),
        },
        ctx,
      );
    }

    case 'ha_service': {
      const domain = str(args.domain);
      const service = str(args.service);
      const entityId = str(args.entity_id);
      if (!domain || !service || !entityId) {
        return { content: 'Invalid ha_service arguments.', isError: true };
      }
      return dispatchAction(
        {
          title: `${domain}.${service} → ${entityId}`,
          detail: `Calls Home Assistant service ${domain}.${service} on ${entityId}.`,
          critical: HA_CRITICAL_DOMAINS.has(domain) || /delete|remove|unlock|disarm/.test(service),
          run: () => haCallService(domain, service, entityId),
        },
        ctx,
      );
    }

    case 'lab_request': {
      const service = str(args.service) as LabService;
      const method = str(args.method).toUpperCase();
      const path = str(args.path);
      const summary = str(args.summary) || `${service} ${method} ${path}`;
      const body = args.body !== undefined ? args.body : undefined;
      if (!LAB_SERVICES.includes(service) || !['GET', 'POST', 'PUT', 'DELETE'].includes(method) || !path) {
        return { content: 'Invalid lab_request arguments (service, method, path required).', isError: true };
      }
      return dispatchAction(
        {
          title: summary,
          detail: `${service}: ${method} ${path}${body !== undefined ? ` ${JSON.stringify(body).slice(0, 120)}` : ''}`,
          critical: labRequestCritical(service, method, path),
          run: () => labRequest(service, method as 'GET' | 'POST' | 'PUT' | 'DELETE', path, body),
        },
        ctx,
      );
    }

    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
}
