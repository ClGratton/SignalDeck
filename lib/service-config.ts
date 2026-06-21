// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: runtime overrides for the homelab BACKEND credentials.
//
// These (Proxmox token, TrueNAS key, Jellyfin key, Home Assistant token,
// Cloudflare token, hosts) normally live in .env.local. This store lets the
// owner edit/add them from the dashboard Settings section instead — values are
// written to data/service-config.json (gitignored) and OVERRIDE the env at read
// time. Env stays the fallback. `cfg(name)` is the single read point that every
// backend module uses, so an edit takes effect on the next probe (no restart).
//
// Secret values never appear in any listing response; they are only returned by
// the re-auth-gated /api/settings/reveal route. Never log a value.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

export interface ServiceField {
  name: string; // the env-var name
  label: string;
  group:
    | 'Proxmox'
    | 'TrueNAS'
    | 'Jellyfin'
    | 'Home Assistant'
    | 'Cloudflare'
    | 'Shell (SSH)'
    | 'Assistant'
    | 'Agent credentials'
    | 'Security & sessions';
  secret: boolean; // masked in the UI; revealed only after re-auth
  placeholder?: string;
  /** True for the credentials the assistant needs ELEVATED to ACT (see CREDENTIALS.md). */
  privilegedForActions?: boolean;
  // ── UI control hint (the value is ALWAYS stored as a string regardless) ──
  /** Render a switch (boolean) or a slider+number (numeric) instead of a text box. */
  control?: 'toggle' | 'slider';
  /** toggle: the effective value when nothing is set (matches the code default). */
  boolDefault?: boolean;
  /** slider: bounds + presentation. The number box accepts values past `max`;
   *  the slider just pins at the end (the stored value is still the typed one). */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** slider: the value shown when nothing is set (matches the code default). */
  numDefault?: number;
  /** slider: label shown at 0 when 0 is a special "disabled" value (off/unlimited). */
  zeroLabel?: string;
}

// The catalog drives the Settings UI and the reveal endpoint. Only these names
// are writable from the dashboard — an arbitrary env var can never be set here.
export const SERVICE_FIELDS: ServiceField[] = [
  { name: 'PROXMOX_HOST', label: 'Host URL', group: 'Proxmox', secret: false, placeholder: 'https://10.0.0.2:8006' },
  { name: 'PROXMOX_TOKEN_ID', label: 'Token ID', group: 'Proxmox', secret: false, placeholder: 'user@pam!tokenname', privilegedForActions: true },
  { name: 'PROXMOX_TOKEN_SECRET', label: 'Token secret', group: 'Proxmox', secret: true, privilegedForActions: true },
  { name: 'PROXMOX_VERIFY_TLS', label: 'Verify TLS', group: 'Proxmox', secret: false, control: 'toggle', boolDefault: true },
  { name: 'TRUENAS_HOST', label: 'Host URL', group: 'TrueNAS', secret: false, placeholder: 'https://10.0.0.3' },
  { name: 'TRUENAS_API_KEY', label: 'API key', group: 'TrueNAS', secret: true, privilegedForActions: true },
  { name: 'JELLYFIN_HOST', label: 'Host URL', group: 'Jellyfin', secret: false },
  { name: 'JELLYFIN_API_KEY', label: 'API key', group: 'Jellyfin', secret: true },
  { name: 'HOMEASSISTANT_HOST', label: 'Host URL', group: 'Home Assistant', secret: false },
  { name: 'HOMEASSISTANT_TOKEN', label: 'Long-lived token', group: 'Home Assistant', secret: true, privilegedForActions: true },
  { name: 'HOMEASSISTANT_ENTITIES', label: 'Pinned entities (comma-separated)', group: 'Home Assistant', secret: false },
  { name: 'HOMEASSISTANT_VERIFY_TLS', label: 'Verify TLS', group: 'Home Assistant', secret: false, control: 'toggle', boolDefault: true },
  { name: 'CLOUDFLARE_API_TOKEN', label: 'API token', group: 'Cloudflare', secret: true },
  { name: 'CLOUDFLARE_ZONE_ID', label: 'Zone ID', group: 'Cloudflare', secret: false },
  // SSH gives the assistant shell access for what the REST APIs can't do (exec
  // into containers, read logs). Point it at the ENTRY Proxmox node; `pct exec`
  // only reaches guests on that node, so for a multi-node cluster the assistant
  // targets the owning node per call (run_shell resolves a node name to its IP).
  { name: 'SSH_HOST', label: 'Host', group: 'Shell (SSH)', secret: false, placeholder: '10.0.0.2', privilegedForActions: true },
  { name: 'SSH_PORT', label: 'Port', group: 'Shell (SSH)', secret: false, placeholder: '22' },
  { name: 'SSH_USER', label: 'User', group: 'Shell (SSH)', secret: false, placeholder: 'root', privilegedForActions: true },
  { name: 'SSH_PASSWORD', label: 'Password (or use a key)', group: 'Shell (SSH)', secret: true },
  { name: 'SSH_PRIVATE_KEY', label: 'Private key (PEM, overrides password)', group: 'Shell (SSH)', secret: true },
  { name: 'SSH_TIMEOUT', label: 'Command timeout', group: 'Shell (SSH)', secret: false, control: 'slider', min: 5, max: 300, step: 5, unit: 's', numDefault: 30 },
  // How many tool steps the agent may take in ONE turn before it pauses and asks
  // you to continue. Higher = longer autonomous runs before a checkpoint.
  { name: 'ASSISTANT_MAX_STEPS', label: 'Agent steps per turn', group: 'Assistant', secret: false, control: 'slider', min: 5, max: 200, step: 5, numDefault: 60 },
  // Which model estimates the price multipliers shown in the model menu, stored
  // as "provider:model". One capable model prices every model better than asking
  // each provider about itself. Chosen via a dropdown in Settings.
  { name: 'ASSISTANT_MULTIPLIER_MODEL', label: 'Token-multiplier model', group: 'Assistant', secret: false },
  // Web search: gives the assistant web_search / web_fetch (public internet).
  // Setting a Tavily key turns the tools on; clearing it hides them again.
  { name: 'TAVILY_API_KEY', label: 'Web search key (Tavily)', group: 'Assistant', secret: true, placeholder: 'tvly-…' },
  // Seconds to wait on a single backend REST call before giving up (so a dead
  // service returns an error instead of stalling the turn). Default 3.5s.
  { name: 'ASSISTANT_REQUEST_TIMEOUT', label: 'Backend request timeout', group: 'Assistant', secret: false, control: 'slider', min: 1, max: 30, step: 0.5, unit: 's', numDefault: 3.5 },
  // Safety: whether the destructive blacklist (destroy/delete/wipe/mkfs/rm -rf)
  // demands a fresh re-auth, and how long that re-auth stays valid. Turning the
  // gate OFF drops it back to the normal confirm flow (NOT recommended).
  { name: 'ASSISTANT_REAUTH_DESTRUCTIVE', label: 'Require re-auth for destructive actions', group: 'Assistant', secret: false, control: 'toggle', boolDefault: true },
  { name: 'ASSISTANT_ELEVATION_MINUTES', label: 'Re-auth elevation window', group: 'Assistant', secret: false, control: 'slider', min: 5, max: 120, step: 5, unit: 'min', numDefault: 30 },
  // Elevated (write-capable) credentials used ONLY by the agent's action path
  // (lab_request / guest_power / ha_service / run_shell), so the read-only
  // dashboard display can keep a least-privilege token. Each falls back to the
  // matching read key when blank — set these to a full-access token to let the
  // agent manage the lab. See cfgAgent().
  { name: 'PROXMOX_TOKEN_ID_AGENT', label: 'Proxmox token ID — write', group: 'Agent credentials', secret: false, placeholder: 'user@pam!agent', privilegedForActions: true },
  { name: 'PROXMOX_TOKEN_SECRET_AGENT', label: 'Proxmox token secret — write', group: 'Agent credentials', secret: true, privilegedForActions: true },
  { name: 'TRUENAS_API_KEY_AGENT', label: 'TrueNAS API key — write', group: 'Agent credentials', secret: true, privilegedForActions: true },
  { name: 'HOMEASSISTANT_TOKEN_AGENT', label: 'Home Assistant token — write', group: 'Agent credentials', secret: true, privilegedForActions: true },
  // Login + session policy (enforced by lib/session-store.ts). All non-secret.
  // 2FA toggle gates the LOGIN code only (re-auth gates for destructive actions
  // are unaffected). Idle = rolling timeout that active use keeps refreshing;
  // absolute = hard ceiling; concurrent = device cap (oldest evicted over it).
  { name: 'AUTH_REQUIRE_2FA', label: 'Require 2FA at login', group: 'Security & sessions', secret: false, control: 'toggle', boolDefault: true },
  { name: 'AUTH_SESSION_IDLE_MINUTES', label: 'Idle timeout', group: 'Security & sessions', secret: false, control: 'slider', min: 0, max: 240, step: 5, unit: 'min', numDefault: 0, zeroLabel: 'off' },
  { name: 'AUTH_SESSION_MAX_HOURS', label: 'Max session age', group: 'Security & sessions', secret: false, control: 'slider', min: 1, max: 336, step: 1, unit: 'h', numDefault: 168 },
  { name: 'AUTH_MAX_SESSIONS', label: 'Max concurrent sessions', group: 'Security & sessions', secret: false, control: 'slider', min: 0, max: 10, step: 1, numDefault: 0, zeroLabel: 'unlimited' },
];

const FIELD_NAMES = new Set(SERVICE_FIELDS.map((f) => f.name));
const FILE = path.join(process.cwd(), 'data', 'service-config.json');

let overrides: Record<string, string> | null = null;
let overridesMtime = -1;

// Re-read whenever the file changed (mtime) so a Settings edit takes effect on
// the very next read — instantly, mid-session, no restart and no waiting for the
// next chat — even if another module instance or process did the write.
function readOverrides(): Record<string, string> {
  let mtime = 0;
  try {
    mtime = fs.statSync(FILE).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (overrides && mtime === overridesMtime) return overrides;
  const next: Record<string, string> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (FIELD_NAMES.has(k) && typeof v === 'string') next[k] = v;
    }
  } catch {
    /* missing/corrupt — empty overrides */
  }
  overrides = next;
  overridesMtime = mtime;
  return overrides;
}

function writeOverrides(next: Record<string, string>): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  overrides = next;
  try {
    overridesMtime = fs.statSync(FILE).mtimeMs;
  } catch {
    overridesMtime = -1;
  }
}

/** THE read point for every backend credential. Override wins; env is fallback. */
export function cfg(name: string): string | undefined {
  const o = readOverrides()[name];
  if (o != null && o !== '') return o;
  const e = process.env[name];
  return e != null && e !== '' ? e : undefined;
}

/** Credential read for the AGENT's WRITE path: prefers the elevated
 *  `<NAME>_AGENT` value, falling back to the read-only key when it's unset — so
 *  the dashboard's display can run on a least-privilege token while the agent
 *  acts with a full-access one. Used only by the action functions in console.ts. */
export function cfgAgent(name: string): string | undefined {
  return cfg(`${name}_AGENT`) ?? cfg(name);
}

export type ConfigSource = 'override' | 'env' | null;

/** Where a field's effective value comes from — for the (value-free) status UI. */
export function fieldSource(name: string): ConfigSource {
  if (readOverrides()[name]) return 'override';
  const e = process.env[name];
  return e != null && e !== '' ? 'env' : null;
}

/** Set/replace an override value (or clear it when empty → falls back to env). */
export function setOverride(name: string, value: string): string | null {
  if (!FIELD_NAMES.has(name)) return 'Unknown setting.';
  const next = { ...readOverrides() };
  if (value.trim() === '') delete next[name];
  else next[name] = value.trim();
  writeOverrides(next);
  console.warn(`[settings] backend credential updated: ${name}`);
  return null;
}

/** Reveal the EFFECTIVE value (override or env). Re-auth is enforced by caller. */
export function revealField(name: string): string | null {
  if (!FIELD_NAMES.has(name)) return null;
  return cfg(name) ?? null;
}
