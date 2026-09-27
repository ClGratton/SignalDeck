'use client';

// Settings → Agent access: tokens for EXTERNAL agents (Claude Code / Codex on the
// owner's desktops) that call the lab tools over the LAN-only MCP endpoint.
// Minting goes through the shared re-auth (reveal) flow; the token is shown ONCE,
// together with ready-to-paste setup for that desktop (built from the LAN
// endpoint URL set above), and is never retrievable again. Below it, the recent
// audit trail of agent calls.

import { useCallback, useEffect, useState } from 'react';
import { Bot, Check, Copy, Trash2 } from 'lucide-react';
import { useReveal } from './RevealProvider';
import styles from './settings.module.css';

interface TokenView {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsed: number | null;
}

interface CallView {
  at: number;
  tokenName: string;
  tool: string;
  request: string;
  ok: boolean;
  ms: number;
}

// Where desktops install the Claude Code plugin from (this project's repo is a
// plugin marketplace: .claude-plugin/marketplace.json). A fork changes this.
const PLUGIN_MARKETPLACE = 'ClGratton/SignalDeck';

function setupSnippets(endpoint: string, token: string) {
  return [
    {
      label: 'Windows (PowerShell) — then restart Claude Code / Codex',
      code: `[Environment]::SetEnvironmentVariable('GRTLABS_MCP_URL', '${endpoint}', 'User'); [Environment]::SetEnvironmentVariable('GRTLABS_AGENT_TOKEN', '${token}', 'User')`,
    },
    {
      label: 'macOS / Linux (shell profile)',
      code: `printf '\\nexport GRTLABS_MCP_URL=%s\\nexport GRTLABS_AGENT_TOKEN=%s\\n' '${endpoint}' '${token}' >> ~/.profile`,
    },
    {
      label: 'Claude Code (once per desktop)',
      code: `/plugin marketplace add ${PLUGIN_MARKETPLACE}\n/plugin install grtlabs@grtlabs`,
    },
    {
      label: 'Codex (~/.codex/config.toml; copy the homelab skill to ~/.codex/skills/)',
      code: `[mcp_servers.grtlabs]\nurl = "${endpoint}"\nbearer_token_env_var = "GRTLABS_AGENT_TOKEN"\ntool_timeout_sec = 600`,
    },
  ];
}

function Snippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.snippet}>
      <div className={styles.snippetHead}>
        <span className={styles.subnote}>{label}</span>
        <button
          type="button"
          className={styles.qrLink}
          onClick={() => {
            navigator.clipboard.writeText(code).then(
              () => setCopied(true),
              () => {},
            );
          }}
        >
          {copied ? <Check size={13} strokeWidth={2.2} aria-hidden /> : <Copy size={13} strokeWidth={2.2} aria-hidden />}{' '}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={`${styles.snippetCode} mono`}>{code}</pre>
    </div>
  );
}

const timeAgo = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export function AgentAccessSettings() {
  const reveal = useReveal();
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [calls, setCalls] = useState<CallView[]>([]);
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/agent-tokens', { cache: 'no-store' });
      if (!res.ok) return setTokens([]);
      const d = (await res.json()) as { tokens: TokenView[]; endpoint: string | null; calls: CallView[] };
      setTokens(d.tokens);
      setEndpoint(d.endpoint);
      setCalls(d.calls);
    } catch {
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mint = useCallback(async () => {
    setBusy(true);
    try {
      const token = await reveal('/api/settings/agent-tokens', { name: name.trim() || 'agent' });
      if (token) {
        setMinted(token);
        setCopied(false);
        setName('');
      }
    } finally {
      setBusy(false);
      void load();
    }
  }, [reveal, name, load]);

  const revoke = useCallback(
    async (id: string) => {
      await fetch('/api/settings/agent-tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {});
      void load();
    },
    [load],
  );

  const copy = useCallback(async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted);
      setCopied(true);
    } catch {
      /* clipboard blocked (plain-HTTP LAN origin) — the field is selectable */
    }
  }, [minted]);

  return (
    <div className={styles.assistantExtras}>
      <section>
        <h3 className={styles.sessionTitle}>Agent access (Claude Code / Codex)</h3>
        <p className={styles.subnote}>
          Lets Claude Code / Codex on your desktops call the lab tools and the shared lab memory
          directly, with no dashboard approval — their own permission mode is the approval. Only
          reachable from the allowed networks, never through Cloudflare. One token per desktop;
          revoke any time.
        </p>

        <div className={styles.inputRow} style={{ marginTop: '0.6rem' }}>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Label, e.g. desk-pc / Claude Code"
            maxLength={60}
            aria-label="Token label"
          />
          <button type="button" className={styles.saveBtn} onClick={() => void mint()} disabled={busy}>
            {busy ? 'Creating…' : 'Create token'}
          </button>
        </div>

        {minted ? (
          <div className={styles.qrBox} style={{ alignItems: 'stretch' }}>
            <p className={styles.subnote}>
              Copy it now — it won&apos;t be shown again. The snippets below already contain it.
            </p>
            <div className={styles.inputRow}>
              <input
                className={`${styles.input} mono`}
                value={minted}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                aria-label="New agent token"
              />
              <button type="button" className={styles.iconBtn} onClick={() => void copy()} aria-label="Copy token">
                {copied ? <Check size={15} strokeWidth={2.2} aria-hidden /> : <Copy size={15} strokeWidth={2.2} aria-hidden />}
              </button>
            </div>
            {endpoint ? (
              setupSnippets(endpoint, minted).map((sn) => <Snippet key={sn.label} {...sn} />)
            ) : (
              <p className={styles.subnote}>
                Set the <strong>LAN endpoint URL</strong> above to get ready-to-paste setup for Claude Code and
                Codex.
              </p>
            )}
            <button type="button" className={styles.qrLink} onClick={() => setMinted(null)}>
              Done
            </button>
          </div>
        ) : null}

        <div className={styles.deviceList}>
          {tokens == null ? (
            <p className={styles.muted}>Loading…</p>
          ) : tokens.length === 0 ? (
            <p className={styles.muted}>No agent tokens.</p>
          ) : (
            tokens.map((t) => (
              <div key={t.id} className={styles.sessionRow}>
                <Bot size={16} strokeWidth={2} aria-hidden className={styles.sessionIcon} />
                <div className={styles.sessionMeta}>
                  <span className={styles.sessionLabel}>{t.name}</span>
                  <span className={`${styles.sessionSub} mono`}>
                    {t.prefix}… · created {timeAgo(t.createdAt)} ·{' '}
                    {t.lastUsed ? `used ${timeAgo(t.lastUsed)}` : 'never used'}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.iconDanger}
                  onClick={() => void revoke(t.id)}
                  aria-label={`Revoke ${t.name}`}
                  title="Revoke this token"
                >
                  <Trash2 size={15} strokeWidth={2.2} aria-hidden />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {calls.length > 0 ? (
        <section>
          <h3 className={styles.sessionTitle}>Recent agent calls</h3>
          <div className={styles.deviceList}>
            {calls.map((c, i) => (
              <div key={`${c.at}-${i}`} className={styles.sessionRow}>
                <div className={styles.sessionMeta}>
                  <span className={styles.sessionLabel}>
                    {c.tool}
                    {c.ok ? null : <span className={styles.badge}>failed</span>}
                  </span>
                  <span className={`${styles.sessionSub} mono`} style={{ overflowWrap: 'anywhere' }}>
                    {c.request}
                  </span>
                  <span className={styles.sessionSub}>
                    {c.tokenName} · {timeAgo(c.at)} · {c.ms} ms
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
