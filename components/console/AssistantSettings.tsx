'use client';

// The Assistant tab's extras inside Settings: model-provider API keys (the same
// write-only key store the sidebar's model menu uses) and the token-multiplier
// estimator dropdown. Keys go in via /api/assistant/keys (never come back out
// except through the re-auth-gated reveal); the multiplier model is a plain
// non-secret config value.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Trash2 } from 'lucide-react';
import { useReveal } from './RevealProvider';
import type { AssistantProvider, ModelsResponse } from '@/lib/assistant/types';
import styles from './settings.module.css';

export function AssistantSettings({
  multiplierValue,
  onSaveMultiplier,
}: {
  multiplierValue: string;
  onSaveMultiplier: (value: string) => void;
}) {
  const reveal = useReveal();
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [keyDraft, setKeyDraft] = useState<Partial<Record<AssistantProvider, string>>>({});
  const [baseDraft, setBaseDraft] = useState<Partial<Record<AssistantProvider, string>>>({});
  const [shown, setShown] = useState<Partial<Record<AssistantProvider, string>>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/assistant/models', { cache: 'no-store' });
      if (r.ok) setCatalog((await r.json()) as ModelsResponse);
    } catch {
      /* leave null — the section just won't list providers */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saveKey = async (provider: AssistantProvider) => {
    const key = (keyDraft[provider] ?? '').trim();
    if (!key) return;
    setMsg(null);
    try {
      const res = await fetch('/api/assistant/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key, baseUrl: baseDraft[provider]?.trim() || undefined }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) return setMsg(body.error ?? 'Could not save the key.');
      setKeyDraft((d) => ({ ...d, [provider]: '' }));
      setMsg('Key saved.');
      await load();
    } catch {
      setMsg('Could not save the key.');
    }
  };

  const removeKey = async (provider: AssistantProvider) => {
    setMsg(null);
    try {
      const res = await fetch('/api/assistant/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) setMsg(body.error ?? 'Could not remove the key.');
      setShown((s) => ({ ...s, [provider]: undefined }));
      await load();
    } catch {
      setMsg('Could not remove the key.');
    }
  };

  const revealKey = async (provider: AssistantProvider) => {
    if (shown[provider]) return setShown((s) => ({ ...s, [provider]: undefined }));
    const value = await reveal('/api/assistant/keys/reveal', { provider });
    if (value) setShown((s) => ({ ...s, [provider]: value }));
  };

  // Flatten the catalog into provider:model options for the estimator dropdown.
  const options = useMemo(() => {
    if (!catalog) return [] as { provider: AssistantProvider; id: string; label: string }[];
    const out: { provider: AssistantProvider; id: string; label: string }[] = [];
    for (const p of catalog.providers) {
      if (!p.source) continue;
      for (const m of catalog.models[p.id] ?? []) out.push({ provider: p.id, id: m.id, label: m.label });
    }
    return out;
  }, [catalog]);

  const providers = catalog?.providers ?? [];

  return (
    <div className={styles.assistantExtras}>
      <section className={styles.group}>
        <h3 className={styles.groupTitle}>Model API keys</h3>
        <p className={styles.subnote}>
          Same keys the model menu uses — stored server-side, write-only. The eye reveals one after
          you re-confirm your password.
        </p>
        {providers.length === 0 ? (
          <p className={styles.muted}>Loading…</p>
        ) : (
          providers.map((p) => (
            <div key={p.id} className={styles.field}>
              <label className={styles.fieldLabel}>
                <span className={styles.fieldName}>{p.label}</span>
                <span className={`${styles.source} mono`} data-src={p.source ?? 'none'}>
                  {p.source ?? 'not set'}
                </span>
              </label>
              <div className={styles.inputRow}>
                <input
                  type={shown[p.id] ? 'text' : 'password'}
                  className={`${styles.input} mono`}
                  value={shown[p.id] ?? keyDraft[p.id] ?? ''}
                  placeholder={p.source ? '•••••• (set — eye to reveal)' : 'Paste an API key'}
                  onChange={(e) => setKeyDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                  readOnly={!!shown[p.id]}
                />
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => void revealKey(p.id)}
                  disabled={!p.source}
                  aria-label={shown[p.id] ? 'Hide key' : 'Reveal key'}
                  title={!p.source ? 'Nothing set yet' : shown[p.id] ? 'Hide' : 'Reveal'}
                >
                  {shown[p.id] ? <EyeOff size={15} strokeWidth={2.2} /> : <Eye size={15} strokeWidth={2.2} />}
                </button>
                <button
                  type="button"
                  className={styles.saveBtn}
                  onClick={() => void saveKey(p.id)}
                  disabled={!(keyDraft[p.id] ?? '').trim()}
                >
                  Save
                </button>
                {p.source === 'stored' ? (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => void removeKey(p.id)}
                    aria-label="Remove key"
                    title="Remove stored key"
                  >
                    <Trash2 size={15} strokeWidth={2.2} />
                  </button>
                ) : null}
              </div>
              {p.customBaseUrl ? (
                <input
                  type="text"
                  className={`${styles.input} mono ${styles.baseInput}`}
                  value={baseDraft[p.id] ?? p.baseUrl ?? ''}
                  placeholder="Base URL (OpenAI-compatible)"
                  onChange={(e) => setBaseDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : null}
            </div>
          ))
        )}
        {msg ? <p className={styles.subnote}>{msg}</p> : null}
      </section>

      <section className={styles.group}>
        <h3 className={styles.groupTitle}>Token-multiplier model</h3>
        <p className={styles.subnote}>
          One model estimates the price multipliers shown in the menu. Pick a capable, cheap one you
          actually have access to (a frontier model prices the whole field better than each provider
          guessing its own).
        </p>
        <div className={styles.selectWrap}>
          <select
            className={styles.select}
            value={multiplierValue}
            onChange={(e) => onSaveMultiplier(e.target.value)}
          >
            <option value="">Auto (each provider prices its own)</option>
            {providers
              .filter((p) => p.source)
              .map((p) => (
                <optgroup key={p.id} label={p.label}>
                  {options
                    .filter((o) => o.provider === p.id)
                    .map((o) => (
                      <option key={`${p.id}:${o.id}`} value={`${p.id}:${o.id}`}>
                        {o.label}
                      </option>
                    ))}
                </optgroup>
              ))}
          </select>
        </div>
      </section>
    </div>
  );
}
