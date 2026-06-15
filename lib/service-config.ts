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
    | 'Agent credentials';
  secret: boolean; // masked in the UI; revealed only after re-auth
  placeholder?: string;
  /** True for the credentials the assistant needs ELEVATED to ACT (see CREDENTIALS.md). */
  privilegedForActions?: boolean;
}

// The catalog drives the Settings UI and the reveal endpoint. Only these names
// are writable from the dashboard — an arbitrary env var can never be set here.
export const SERVICE_FIELDS: ServiceField[] = [
  { name: 'PROXMOX_HOST', label: 'Host URL', group: 'Proxmox', secret: false, placeholder: 'https://10.0.0.2:8006' },
  { name: 'PROXMOX_TOKEN_ID', label: 'Token ID', group: 'Proxmox', secret: false, placeholder: 'user@pam!tokenname', privilegedForActions: true },
  { name: 'PROXMOX_TOKEN_SECRET', label: 'Token secret', group: 'Proxmox', secret: true, privilegedForActions: true },
  { name: 'PROXMOX_VERIFY_TLS', label: 'Verify TLS (false for self-signed)', group: 'Proxmox', secret: false, placeholder: 'true' },
  { name: 'TRUENAS_HOST', label: 'Host URL', group: 'TrueNAS', secret: false, placeholder: 'https://10.0.0.3' },
  { name: 'TRUENAS_API_KEY', label: 'API key', group: 'TrueNAS', secret: true, privilegedForActions: true },
  { name: 'JELLYFIN_HOST', label: 'Host URL', group: 'Jellyfin', secret: false },
  { name: 'JELLYFIN_API_KEY', label: 'API key', group: 'Jellyfin', secret: true },
  { name: 'HOMEASSISTANT_HOST', label: 'Host URL', group: 'Home Assistant', secret: false },
  { name: 'HOMEASSISTANT_TOKEN', label: 'Long-lived token', group: 'Home Assistant', secret: true, privilegedForActions: true },
  { name: 'HOMEASSISTANT_ENTITIES', label: 'Pinned entities (comma-separated)', group: 'Home Assistant', secret: false },
  { name: 'HOMEASSISTANT_VERIFY_TLS', label: 'Verify TLS (false for self-signed)', group: 'Home Assistant', secret: false, placeholder: 'true' },
  { name: 'CLOUDFLARE_API_TOKEN', label: 'API token', group: 'Cloudflare', secret: true },
  { name: 'CLOUDFLARE_ZONE_ID', label: 'Zone ID', group: 'Cloudflare', secret: false },
  // SSH gives the assistant shell access for what the REST APIs can't do (exec
  // into containers, read logs). Point it at the Proxmox node — `pct exec`
  // reaches every container from there.
  { name: 'SSH_HOST', label: 'Host', group: 'Shell (SSH)', secret: false, placeholder: '10.0.0.2', privilegedForActions: true },
  { name: 'SSH_PORT', label: 'Port', group: 'Shell (SSH)', secret: false, placeholder: '22' },
  { name: 'SSH_USER', label: 'User', group: 'Shell (SSH)', secret: false, placeholder: 'root', privilegedForActions: true },
  { name: 'SSH_PASSWORD', label: 'Password (or use a key)', group: 'Shell (SSH)', secret: true },
  { name: 'SSH_PRIVATE_KEY', label: 'Private key (PEM, overrides password)', group: 'Shell (SSH)', secret: true },
  // How many tool steps the agent may take in ONE turn before it pauses and asks
  // you to continue. Higher = longer autonomous runs before a checkpoint.
  { name: 'ASSISTANT_MAX_STEPS', label: 'Agent steps per turn (default 60)', group: 'Assistant', secret: false, placeholder: '60' },
  // Which model estimates the price multipliers shown in the model menu, stored
  // as "provider:model". One capable model prices every model better than asking
  // each provider about itself. Chosen via a dropdown in Settings.
  { name: 'ASSISTANT_MULTIPLIER_MODEL', label: 'Token-multiplier model', group: 'Assistant', secret: false },
  // Seconds to wait on a single backend REST call before giving up (so a dead
  // service returns an error instead of stalling the turn). Default 3.5s.
  { name: 'ASSISTANT_REQUEST_TIMEOUT', label: 'Backend request timeout (seconds, default 3.5)', group: 'Assistant', secret: false, placeholder: '3.5' },
  // Safety: whether the destructive blacklist (destroy/delete/wipe/mkfs/rm -rf)
  // demands a fresh re-auth, and how long that re-auth stays valid. Set the gate
  // to "false" to drop it back to the normal confirm flow (NOT recommended).
  { name: 'ASSISTANT_REAUTH_DESTRUCTIVE', label: 'Require re-auth for destructive actions (true/false)', group: 'Assistant', secret: false, placeholder: 'true' },
  { name: 'ASSISTANT_ELEVATION_MINUTES', label: 'Re-auth elevation window (minutes, default 30)', group: 'Assistant', secret: false, placeholder: '30' },
  // Elevated (write-capable) credentials used ONLY by the agent's action path
  // (lab_request / guest_power / ha_service / run_shell), so the read-only
  // dashboard display can keep a least-privilege token. Each falls back to the
  // matching read key when blank — set these to a full-access token to let the
  // agent manage the lab. See cfgAgent().
  { name: 'PROXMOX_TOKEN_ID_AGENT', label: 'Proxmox token ID — write', group: 'Agent credentials', secret: false, placeholder: 'user@pam!agent', privilegedForActions: true },
  { name: 'PROXMOX_TOKEN_SECRET_AGENT', label: 'Proxmox token secret — write', group: 'Agent credentials', secret: true, privilegedForActions: true },
  { name: 'TRUENAS_API_KEY_AGENT', label: 'TrueNAS API key — write', group: 'Agent credentials', secret: true, privilegedForActions: true },
  { name: 'HOMEASSISTANT_TOKEN_AGENT', label: 'Home Assistant token — write', group: 'Agent credentials', secret: true, privilegedForActions: true },
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
