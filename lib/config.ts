// ─────────────────────────────────────────────────────────────────────────────
// Public landing configuration.
//
// Everything here is shown to anonymous visitors, so it must stay non-sensitive:
// no hostnames, IPs, ports, or service contents. These are PLACEHOLDER values —
// swap them for your own. The aggregate health numbers come from lib/status.ts,
// not from here.
// ─────────────────────────────────────────────────────────────────────────────

export const lab = {
  name: 'Grtlabs',
  tagline: 'Everything I run, under one roof.',
  /** IANA timezone for the live clock. */
  timeZone: 'America/Toronto',
  /** Short location label shown next to the clock. */
  place: 'Home rack',
  /** Shown in the footer. Bump it when you ship changes. */
  version: 'v1.0',
} as const;

export interface BragStat {
  /** Lowercase label, rendered in mono. */
  label: string;
  /** The headline figure. With `used` set, this is the total/capacity. */
  value: string;
  unit?: string;
  /** Optional amount in use; renders as "used / total" in the same cell. */
  used?: string;
}

/** Cold-start fallbacks only — the page swaps in live Proxmox/TrueNAS numbers
 *  as soon as a probe lands. Keep these matching the REAL rig so a missed probe
 *  never shows invented hardware. Nothing here identifies a host or service. */
export const bragStats: BragStat[] = [
  { label: 'cores', value: '12' },
  { label: 'memory', value: '29', unit: 'GB' },
  { label: 'storage', value: '4', unit: 'TB', used: '1.9' },
  { label: 'containers', value: '9' },
  { label: 'vms', value: '2' },
];

/** Subdomains pinned as the live "wires" in the background viz. They render
 *  ALWAYS (even at zero Cloudflare traffic) so the indicators never vanish;
 *  Cloudflare overlays each one's real requests/min when it has data. One per
 *  wave (3 max). These are shown publicly — edit to your own. Leave the array
 *  empty to instead auto-pick the three busiest hosts Cloudflare reports. */
export const trafficLanes: string[] = [
  'nas.grtlabs.xyz',
  'home.grtlabs.xyz',
  'media.grtlabs.xyz',
];

export interface StackItem {
  name: string;
  role: string;
}

/** The "powered by" list. Naming the software is a flex, not a leak. */
export const stack: StackItem[] = [
  { name: 'Proxmox VE', role: 'hypervisor' },
  { name: 'TrueNAS SCALE', role: 'storage' },
  { name: 'Jellyfin', role: 'media' },
  { name: 'Home Assistant', role: 'automation' },
];

/** Per-system health. 'degraded' is the amber "not fully working" state. */
export type SystemHealth = 'ok' | 'degraded' | 'down';

export interface SystemNode {
  name: string;
  /** Human uptime label, e.g. "141d". PLACEHOLDER until a real probe fills it. */
  uptime: string;
  health: SystemHealth;
}

/** Per-system status shown when hovering the main status bar. Placeholders until
 *  a real probe (Proxmox/TrueNAS/etc.) reports uptime + health. Names only, no
 *  hostnames/IPs — safe for the public landing. */
export const systems: SystemNode[] = [
  { name: 'Proxmox VE', uptime: '141d', health: 'ok' },
  { name: 'TrueNAS SCALE', uptime: '141d', health: 'ok' },
  { name: 'Jellyfin', uptime: '37d', health: 'ok' },
  { name: 'Home Assistant', uptime: '88d', health: 'ok' },
];

export interface OutboundLink {
  label: string;
  href: string;
}

export const links: OutboundLink[] = [
  { label: 'GitHub', href: 'https://github.com/' },
  { label: 'Notes', href: '#' },
  { label: 'Status', href: '#' },
];
