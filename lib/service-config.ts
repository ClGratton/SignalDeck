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
  group: 'Proxmox' | 'TrueNAS' | 'Jellyfin' | 'Home Assistant' | 'Cloudflare' | 'Shell (SSH)';
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
];

const FIELD_NAMES = new Set(SERVICE_FIELDS.map((f) => f.name));
const FILE = path.join(process.cwd(), 'data', 'service-config.json');

let overrides: Record<string, string> | null = null;

function readOverrides(): Record<string, string> {
  if (overrides) return overrides;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, unknown>;
    overrides = {};
    for (const [k, v] of Object.entries(raw)) {
      if (FIELD_NAMES.has(k) && typeof v === 'string') overrides[k] = v;
    }
  } catch {
    overrides = {};
  }
  return overrides;
}

function writeOverrides(next: Record<string, string>): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  overrides = next;
}

/** THE read point for every backend credential. Override wins; env is fallback. */
export function cfg(name: string): string | undefined {
  const o = readOverrides()[name];
  if (o != null && o !== '') return o;
  const e = process.env[name];
  return e != null && e !== '' ? e : undefined;
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
