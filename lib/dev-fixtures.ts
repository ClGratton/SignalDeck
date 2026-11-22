// ─────────────────────────────────────────────────────────────────────────────
// DEV-ONLY fixtures: realistic populated data so the dashboard can be audited
// locally without reachable backends. Inert in production: it needs BOTH
// SIGNALDECK_FIXTURES=1 AND an AUTH_SECRET that starts with "local-fixture-"
// (a prefix no real deployment secret carries), so a stray env flag on a real
// deploy does nothing. Never import from client code.
// ─────────────────────────────────────────────────────────────────────────────
import 'server-only';
import type { ConsoleSnapshot, ConsoleGuest } from '@/lib/console';

export function fixturesOn(): boolean {
  return (
    process.env.SIGNALDECK_FIXTURES === '1' &&
    (process.env.AUTH_SECRET ?? '').startsWith('local-fixture-')
  );
}

const names = [
  'coolify-app-server', 'jellyfin', 'nginx-proxy-manager', 'home-assistant-os', 'truenas-scale',
  'immich-photo-library-with-machine-learning', 'vaultwarden', 'pihole-primary', 'pihole-secondary',
  'grafana', 'prometheus', 'loki-logs', 'paperless-ngx', 'nextcloud-aio', 'gitea', 'ci-runner-01',
  'ci-runner-02', 'media-downloader', 'sonarr', 'radarr', 'prowlarr', 'zigbee2mqtt', 'mosquitto',
  'node-red', 'esphome-builder', 'frigate-nvr-cameras', 'minecraft-survival', 'backup-pbs', 'test-sandbox',
];

function guests(): ConsoleGuest[] {
  return names.map((name, i) => ({
    vmid: 100 + i,
    name,
    type: i % 3 === 0 ? 'qemu' : 'lxc',
    status: i % 9 === 8 ? 'stopped' : i === 11 ? 'paused' : 'running',
    node: i % 2 ? 'proxmox02' : 'proxmox01',
    cpuPct: i % 9 === 8 ? 0 : (i * 37) % 97,
    maxcpu: 1 + (i % 6),
    memGB: 0.3 + ((i * 7) % 40) / 10,
    maxmemGB: 4 + (i % 5) * 2,
    uptimeSeconds: i % 9 === 8 ? 0 : 3600 * (i * 13 + 2),
  }));
}

export function fixtureSnapshot(): ConsoleSnapshot {
  const ds = ['media/movies', 'media/tv', 'photos/immich-library', 'backups/pbs', 'apps/nextcloud-data', 'vm-disks', 'docs'];
  const ent = [
    ['Living room temperature', '21.4', '°C'], ['Outdoor humidity', '63', '%'], ['Grid power draw', '1.84', 'kW'],
    ['Solar production today', '12.6', 'kWh'], ['Washing machine state', 'idle', null], ['Front door', 'closed', null],
    ['Garage door (left bay, opener controller)', 'open', null], ['Bedroom CO2', '612', 'ppm'],
    ['Heating boiler flow temp', '48.5', '°C'], ['Server rack power', '212', 'W'], ['UPS load', '31', '%'],
    ['Rain sensor', 'dry', null], ['Window office', 'unavailable', null], ['Hallway motion', 'off', null],
    ['Dishwasher', 'running', null], ['EV charger', 'charging', null],
  ] as const;
  return {
    at: new Date().toISOString(),
    proxmox: {
      load: 62, cores: 24, memUsedGB: 71.4, memTotalGB: 96, uptimeSeconds: 86400 * 41,
      nodesOnline: 2, nodesTotal: 3, guests: guests(),
    },
    truenas: {
      reachable: true, uptimeSeconds: 86400 * 19,
      pools: [
        { name: 'tank', usedTB: 31.82, totalTB: 36.4, healthy: true },
        { name: 'fast-nvme-scratch', usedTB: 0.91, totalTB: 1.8, healthy: true },
        { name: 'archive-degraded', usedTB: 7.2, totalTB: 8, healthy: false },
      ],
      datasets: Array.from({ length: 14 }, (_, i) => ({
        name: `tank/${ds[i % 7]}${i > 6 ? `-${i}` : ''}`,
        usedGB: 120 + i * 311, availGB: 4000 - i * 90,
      })),
      temps: Array.from({ length: 10 }, (_, i) => ({ disk: `sd${String.fromCharCode(97 + i)}`, celsius: 31 + i * 2 })),
    },
    jellyfin: {
      online: true,
      sessions: [
        { user: 'claudio', client: 'Jellyfin Android TV on Living Room Shield', playing: 'Dune: Part Two (2024) - Extended Cut with commentary', progressPct: 43, paused: false },
        { user: 'guest-with-a-very-long-account-name', client: 'Safari', playing: null, progressPct: null, paused: false },
        { user: 'anna', client: 'Jellyfin iOS', playing: 'The Bear S03E04', progressPct: 88, paused: true },
      ],
    },
    homeassistant: {
      online: true, totalEntities: 412,
      entities: ent.map(([name, state, unit], i) => ({ id: `sensor.e${i}`, name, state, unit })),
    },
  };
}

const FENCE = '```';
const md = [
  'Here is the picture of the lab right now.',
  '',
  '## Summary',
  '- **proxmox01** is healthy, 62% core-weighted load',
  '- `archive-degraded` pool is **DEGRADED**: one disk is reporting errors',
  '- 3 guests are stopped: `test-sandbox`, `ci-runner-02`, `mosquitto`',
  '',
  FENCE + 'bash',
  'zpool status archive-degraded',
  '# pool: archive-degraded',
  '# state: DEGRADED  scan: resilver in progress since Sun Nov 22 03:12:44',
  FENCE,
  '',
  '| guest | vmid | cpu | mem |',
  '|---|---|---|---|',
  '| immich-photo-library-with-machine-learning | 105 | 91% | 7.9 GB |',
  '| jellyfin | 101 | 22% | 2.1 GB |',
  '',
  'A long unbroken token to test wrapping: ' + 'abcdef0123456789'.repeat(8),
].join('\n');

export function fixtureChats() {
  const t = Date.now();
  const items: unknown[] = [];
  for (let i = 0; i < 14; i++) {
    items.push({ kind: 'user', text: `Question ${i + 1}: check the state of the lab and tell me what needs attention, then compare against yesterday.`, at: t - (30 - i) * 60000 });
    items.push({ kind: 'tool', label: 'get_console_snapshot' });
    items.push({ kind: 'tool', label: 'lab_get proxmox /cluster/resources' });
    items.push({ kind: 'action', id: `a${i}`, title: 'Restart guest 105 (immich)', status: 'ok', detail: 'POST /nodes/proxmox01/lxc/105/status/reboot', request: '{"timeout":60}' });
    items.push({ kind: 'assistant', text: md });
  }
  items.push({ kind: 'error', text: 'Anthropic request failed: 529 overloaded_error (retrying in 8s)' });
  return {
    activeId: 'fx1',
    chats: [
      { id: 'fx1', title: 'Lab health review and the degraded archive pool', createdAt: t - 7200000, updatedAt: t, serverVersion: 0, items },
      { id: 'fx2', title: 'Why is Jellyfin buffering on the living room Shield', createdAt: t - 9e7, updatedAt: t - 9e7, serverVersion: 0, items: items.slice(0, 5) },
    ],
  };
}
