'use client';

// Dashboard Settings: edit the homelab BACKEND credentials (Proxmox token,
// TrueNAS/Jellyfin/HA/Cloudflare keys, hosts) from the browser. Values are
// write-mostly — a field's current value is shown only after the re-auth
// reveal (eye). Saving writes a runtime override that beats .env.local on the
// next probe; clearing a field falls back to env.

import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, ShieldAlert, X } from 'lucide-react';
import { useReveal } from './RevealProvider';
import styles from './settings.module.css';

interface FieldDto {
  name: string;
  label: string;
  group: string;
  secret: boolean;
  placeholder?: string;
  privilegedForActions: boolean;
  source: 'override' | 'env' | null;
}

type Draft = { value: string; revealed: boolean; dirty: boolean; saving?: boolean; saved?: boolean };

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const reveal = useReveal();
  const [fields, setFields] = useState<FieldDto[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (res.ok) setFields(((await res.json()) as { fields: FieldDto[] }).fields);
    } catch {
      setFields([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const setDraft = (name: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({
      ...d,
      [name]: { ...{ value: '', revealed: false, dirty: false }, ...d[name], ...patch },
    }));

  const onReveal = async (f: FieldDto) => {
    const cur = drafts[f.name];
    if (cur?.revealed) {
      setDraft(f.name, { revealed: false });
      return;
    }
    const value = await reveal('/api/settings/reveal', { name: f.name });
    if (value != null) setDraft(f.name, { value, revealed: true, dirty: false });
  };

  const onSave = async (f: FieldDto) => {
    const d = drafts[f.name];
    if (!d || !d.dirty) return;
    setDraft(f.name, { saving: true });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name, value: d.value }),
      });
      const body = (await res.json()) as { source?: FieldDto['source']; error?: string };
      if (res.ok) {
        setFields((fs) => fs?.map((x) => (x.name === f.name ? { ...x, source: body.source ?? x.source } : x)) ?? fs);
        setDraft(f.name, { dirty: false, saving: false, saved: true });
        setTimeout(() => setDraft(f.name, { saved: false }), 1800);
      } else {
        setDraft(f.name, { saving: false });
      }
    } catch {
      setDraft(f.name, { saving: false });
    }
  };

  const groups = [...new Set((fields ?? []).map((f) => f.group))];

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Backend settings">
      <button type="button" className={styles.scrim} onClick={onClose} aria-label="Close settings" />
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 className={styles.title}>Backend credentials</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} strokeWidth={2.2} aria-hidden />
          </button>
        </header>
        <p className={styles.intro}>
          These power the panels and the assistant. They override <code className="mono">.env.local</code>{' '}
          on the next probe. The eye reveals a current value after you re-confirm your password.
          Fields flagged <ShieldAlert size={12} strokeWidth={2.4} aria-hidden /> need an elevated
          token for the assistant to perform actions (see CREDENTIALS.md).
        </p>

        <div className={styles.scroll}>
          {fields == null ? (
            <p className={styles.muted}>Loading…</p>
          ) : (
            groups.map((g) => (
              <section key={g} className={styles.group}>
                <h3 className={styles.groupTitle}>{g}</h3>
                {fields
                  .filter((f) => f.group === g)
                  .map((f) => {
                    const d = drafts[f.name] ?? { value: '', revealed: false, dirty: false };
                    const masked = f.secret && !d.revealed;
                    return (
                      <div key={f.name} className={styles.field}>
                        <label className={styles.fieldLabel} htmlFor={`set-${f.name}`}>
                          <span className={styles.fieldName}>
                            {f.label}
                            {f.privilegedForActions ? (
                              <ShieldAlert
                                size={12}
                                strokeWidth={2.4}
                                aria-hidden
                                className={styles.privIcon}
                              />
                            ) : null}
                          </span>
                          <span
                            className={`${styles.source} mono`}
                            data-src={f.source ?? 'none'}
                          >
                            {f.source ?? 'not set'}
                          </span>
                        </label>
                        <div className={styles.inputRow}>
                          <input
                            id={`set-${f.name}`}
                            type={masked ? 'password' : 'text'}
                            className={`${styles.input} ${f.secret ? 'mono' : ''}`}
                            value={d.value}
                            placeholder={
                              d.revealed
                                ? ''
                                : f.source
                                  ? f.secret
                                    ? '•••••• (set — eye to reveal)'
                                    : '(set — eye to reveal)'
                                  : (f.placeholder ?? '')
                            }
                            onChange={(e) => setDraft(f.name, { value: e.target.value, dirty: true })}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          {f.secret ? (
                            <button
                              type="button"
                              className={styles.iconBtn}
                              onClick={() => void onReveal(f)}
                              aria-label={d.revealed ? 'Hide value' : 'Reveal value'}
                              disabled={!f.source && !d.dirty}
                              title={!f.source ? 'Nothing set yet' : d.revealed ? 'Hide' : 'Reveal'}
                            >
                              {d.revealed ? (
                                <EyeOff size={15} strokeWidth={2.2} aria-hidden />
                              ) : (
                                <Eye size={15} strokeWidth={2.2} aria-hidden />
                              )}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={styles.saveBtn}
                            onClick={() => void onSave(f)}
                            disabled={!d.dirty || d.saving}
                          >
                            {d.saving ? '…' : d.saved ? 'Saved' : 'Save'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
