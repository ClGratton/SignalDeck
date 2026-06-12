// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: SSH shell access to the lab.
//
// Some things the REST APIs simply cannot do — exec inside a container
// (`pct exec <vmid> -- ...`), read a service's logs (`journalctl`), inspect a
// config file. For those the assistant runs a command over SSH on the host
// configured in Settings (typically the Proxmox node, from which `pct exec`
// reaches every container). Credentials come from service-config (env or the
// override store) and never reach the browser.
//
// This is the most powerful capability in the app — it is ALWAYS treated as a
// critical action (operator confirmation in agent "critical"/"all" modes).
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { Client } from 'ssh2';
import { cfg } from '@/lib/service-config';

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 8000;

export function sshConfigured(): boolean {
  return !!cfg('SSH_HOST') && !!cfg('SSH_USER') && !!(cfg('SSH_PASSWORD') || cfg('SSH_PRIVATE_KEY'));
}

/** Run one command over SSH and return combined stdout/stderr (clipped). */
export function sshRun(command: string): Promise<{ ok: boolean; detail: string }> {
  const host = cfg('SSH_HOST');
  const user = cfg('SSH_USER');
  const password = cfg('SSH_PASSWORD');
  const privateKey = cfg('SSH_PRIVATE_KEY');
  const port = Number(cfg('SSH_PORT') ?? '22') || 22;
  if (!host || !user || (!password && !privateKey)) {
    return Promise.resolve({ ok: false, detail: 'SSH is not configured (set host, user, and a password or key in Settings).' });
  }

  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    let stdout = '';
    let stderr = '';
    const done = (r: { ok: boolean; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.end();
      } catch {
        /* closing */
      }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, detail: 'SSH command timed out.' }), TIMEOUT_MS);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return done({ ok: false, detail: `SSH exec failed: ${err.message}` });
        stream
          .on('close', (code: number) => {
            // The command RAN: that is a success of the action even when the
            // command itself exits non-zero (grep found nothing, a probe
            // failed, etc.). exit≠0 is information for the model, not a failure
            // of run_shell — only a real infra error (no connect / timeout)
            // resolves ok:false above. stdout and stderr are kept separate so
            // the action card can show them in their own sections.
            const parts: string[] = [];
            if (stdout.trim()) parts.push(stdout.trim());
            if (stderr.trim()) parts.push('--- stderr ---\n' + stderr.trim());
            let body = parts.join('\n') || '(no output)';
            if (body.length > MAX_OUTPUT) body = body.slice(0, MAX_OUTPUT) + '… (truncated)';
            done({ ok: true, detail: `exit ${code}\n${body}` });
          })
          .on('data', (d: Buffer) => {
            stdout += d.toString('utf8');
          })
          .stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });
      });
    });
    conn.on('error', (err) => done({ ok: false, detail: `SSH connection failed: ${err.message}` }));

    try {
      conn.connect({
        host: host.replace(/^ssh:\/\//, '').replace(/:\d+$/, ''),
        port,
        username: user,
        ...(privateKey ? { privateKey } : { password }),
        readyTimeout: TIMEOUT_MS,
        // Self-hosted lab hosts; host-key pinning is out of scope here.
        algorithms: undefined,
      });
    } catch (err) {
      done({ ok: false, detail: `SSH error: ${(err as Error).message}` });
    }
  });
}
