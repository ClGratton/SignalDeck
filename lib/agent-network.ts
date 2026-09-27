// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: "is this request from the local network?" for the external-agent
// MCP endpoint (app/api/agent/mcp).
//
// A Next route can't see the socket address, so this reads the proxy headers.
// The rule: EVERY address in X-Forwarded-For and X-Real-IP must fall inside an
// allowed network (default: private/loopback/link-local ranges). A request from
// the internet always passes through at least one reverse proxy (Cloudflare,
// NPM, Traefik, cloudflared…), and that proxy appends the real public client
// address — which fails the check. A client can PREPEND fake private addresses,
// but can't remove the one its proxy appended, so checking all hops is sound.
// No forwarding headers at all means a direct connection to the app port, which
// is only reachable from inside the LAN / container network.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';

export const DEFAULT_AGENT_NETWORKS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.every((n) => n >= 0 && n <= 255) ? out : null;
}

function parseV6(ip: string): number[] | null {
  // Embedded IPv4 tail (e.g. ::ffff:192.168.1.5) → two 16-bit groups.
  let s = ip.toLowerCase().split('%')[0];
  const v4tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4tail) {
    const v4 = parseV4(v4tail[1]);
    if (!v4) return null;
    s = s.slice(0, -v4tail[1].length) + `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** Bytes of an address, unwrapping IPv4-mapped IPv6 so "::ffff:10.0.0.1"
 *  matches "10.0.0.0/8". */
function toBytes(ip: string): number[] | null {
  const v4 = parseV4(ip);
  if (v4) return v4;
  const v6 = parseV6(ip);
  if (!v6) return null;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? v6.slice(12) : v6;
}

function inCidr(ip: number[], cidr: string): boolean {
  const [base, bitsRaw] = cidr.trim().split('/');
  const net = toBytes(base ?? '');
  if (!net || net.length !== ip.length) return false;
  const bits = bitsRaw === undefined ? net.length * 8 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > net.length * 8) return false;
  for (let i = 0; i < net.length; i++) {
    const take = Math.min(8, Math.max(0, bits - i * 8));
    if (take === 0) break;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((ip[i] & mask) !== (net[i] & mask)) return false;
  }
  return true;
}

/** Strip a port / brackets from a forwarded address ("1.2.3.4:5678", "[::1]:80"). */
function cleanAddr(raw: string): string {
  const s = raw.trim().replace(/^"|"$/g, '');
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket) return bracket[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  return v4port ? v4port[1] : s;
}

/** Parse the allowed-networks setting (comma/space separated CIDRs); blank → defaults. */
export function agentNetworks(setting: string | undefined): string[] {
  const list = (setting ?? '').split(/[\s,]+/).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_AGENT_NETWORKS;
}

/** True when every forwarded hop is inside an allowed network (or there are no
 *  forwarding headers — a direct LAN/container connection). */
export function isLocalRequest(headers: Headers, networks: string[]): boolean {
  const hops = [
    ...(headers.get('x-forwarded-for') ?? '').split(','),
    headers.get('x-real-ip') ?? '',
  ]
    .map(cleanAddr)
    .filter(Boolean);
  return hops.every((hop) => {
    const bytes = toBytes(hop);
    return bytes != null && networks.some((c) => inCidr(bytes, c));
  });
}
