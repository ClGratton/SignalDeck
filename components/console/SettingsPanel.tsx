'use client';

// Dashboard Settings: edit the homelab BACKEND credentials (Proxmox token,
// TrueNAS/Jellyfin/HA/Cloudflare keys, hosts) plus assistant knobs from the
// browser. A left nav lists each section; the selected one's fields show on the
// right. Values are write-mostly — a field's current value is shown only after
// the re-auth reveal (eye). Saving writes a runtime override that beats
// .env.local on the next probe; clearing a field falls back to env.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { StateBlock } from '@/components/ui/StateBlock';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { useReveal } from './RevealProvider';
import { AssistantSettings } from './AssistantSettings';
import { SessionsSettings } from './SessionsSettings';
import { AgentAccessSettings } from './AgentAccessSettings';
import styles from './settings.module.css';

interface FieldDto {
  name: string;
  label: string;
  group: string;
  secret: boolean;
  placeholder?: string;
  privilegedForActions: boolean;
  source: 'override' | 'env' | null;
  /** Present for non-secret fields only — shown/edited directly. */
  value?: string;
  /** Control hint: a switch (boolean) or a slider+number (numeric). */
  control?: 'toggle' | 'slider';
  boolDefault?: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  numDefault?: number;
  zeroLabel?: string;
}

const isTruthy = (v: string | undefined): boolean => /^(true|1|yes|on)$/i.test((v ?? '').trim());

type Draft = { value: string; revealed: boolean; revealedAt?: number; dirty: boolean; saving?: boolean; saved?: boolean; error?: string };

const REVEAL_SECONDS = 30;

/** Settings drawer: shared Dialog (Escape, focus trap/return, scroll lock) + unsaved-changes guard. */
export function SettingsPanel({
  open,
  onClose,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const dirtyRef = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (dirtyRef.current) setConfirmClose(true);
    else onClose();
  };
  const setDirty = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);
  return (
    <>
      <Dialog open={open} onClose={requestClose} title="Settings" variant="sheet" returnFocus={returnFocus}>
        <SettingsBody onDirty={setDirty} />
      </Dialog>
      <ConfirmDialog
        open={confirmClose}
        title="Discard unsaved changes?"
        message="Some fields were edited but not saved. Closing now discards them."
        confirmLabel="Discard"
        danger
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          setConfirmClose(false);
          dirtyRef.current = false;
          onClose();
        }}
      />
    </>
  );
}

function SettingsBody({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const reveal = useReveal();
  const toast = useToast();
  const [loadError, setLoadError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [fields, setFields] = useState<FieldDto[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [active, setActive] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      {
        const fs = ((await res.json()) as { fields: FieldDto[] }).fields;
        setLoadError(false);
        setFields(fs);
        // Seed non-secret values straight into the editable fields.
        setDrafts((d) => {
          const next = { ...d };
          for (const f of fs) {
            if (!f.secret && f.value != null && next[f.name] == null) {
              next[f.name] = { value: f.value, revealed: true, dirty: false };
            }
          }
          return next;
        });
      }
    } catch {
      setFields([]);
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Unsaved-changes signal for the close guard.
  useEffect(() => {
    onDirty(Object.values(drafts).some((d) => d.dirty));
  }, [drafts, onDirty]);

  // Revealed secrets hide themselves after REVEAL_SECONDS (value dropped from state unless edited).
  const anyRevealed = Object.values(drafts).some((d) => d.revealedAt != null);
  useEffect(() => {
    if (!anyRevealed) return;
    const iv = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      setDrafts((d) => {
        let changed = false;
        const next = { ...d };
        for (const [k, v] of Object.entries(d)) {
          if (v.revealedAt != null && n - v.revealedAt >= REVEAL_SECONDS * 1000) {
            next[k] = { ...v, revealed: false, revealedAt: undefined, value: v.dirty ? v.value : '' };
            changed = true;
          }
        }
        return changed ? next : d;
      });
    }, 1000);
    return () => window.clearInterval(iv);
  }, [anyRevealed]);

  const groups = useMemo(() => [...new Set((fields ?? []).map((f) => f.group))], [fields]);
  useEffect(() => {
    if (groups.length && (active == null || !groups.includes(active))) setActive(groups[0]);
  }, [groups, active]);

  // Sliding indicator behind the active nav item (MI3).
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<React.CSSProperties>({ opacity: 0 });
  useLayoutEffect(() => {
    const nav = navRef.current;
    const el = nav?.querySelector<HTMLElement>('[data-active]');
    if (!nav || !el) return;
    setIndicator({
      opacity: 1,
      width: el.offsetWidth,
      height: el.offsetHeight,
      transform: `translate(${el.offsetLeft}px, ${el.offsetTop}px)`,
    });
  }, [active, fields]);

  const setDraft = (name: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({
      ...d,
      [name]: { ...{ value: '', revealed: false, dirty: false }, ...d[name], ...patch },
    }));

  const onReveal = async (f: FieldDto) => {
    const cur = drafts[f.name];
    if (cur?.revealed) {
      setDraft(f.name, { revealed: false, revealedAt: undefined, value: cur.dirty ? cur.value : '' });
      return;
    }
    // Nothing stored to reveal — don't make the operator pass the re-auth gate
    // just to be told "Not set." Say it up front (the eye is only reachable here
    // when they've typed an UNSAVED value).
    if (!f.source) {
      setDraft(f.name, { error: 'Nothing saved yet — save a value first, then reveal.' });
      return;
    }
    const value = await reveal('/api/settings/reveal', { name: f.name });
    if (value != null) {
      setNow(Date.now());
      setDraft(f.name, { value, revealed: true, revealedAt: Date.now(), dirty: false });
    }
  };

  // Direct save (no draft/dirty dance) — used by the multiplier dropdown.
  const saveValue = useCallback(async (name: string, value: string) => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value }),
      });
      const body = (await res.json()) as { source?: FieldDto['source']; error?: string };
      if (res.ok) {
        setFields(
          (fs) =>
            fs?.map((x) =>
              x.name === name ? { ...x, source: body.source ?? x.source, value } : x,
            ) ?? fs,
        );
      }
    } catch {
      /* ignore — the dropdown keeps the prior value */
    }
  }, []);

  // Optimistic commit for the toggle/slider controls: reflect the new value in
  // the UI immediately, then persist (saveValue reconciles source on success).
  const commitValue = useCallback(
    (name: string, value: string) => {
      setFields((fs) => fs?.map((x) => (x.name === name ? { ...x, value } : x)) ?? fs);
      void saveValue(name, value);
    },
    [saveValue],
  );

  const onSave = async (f: FieldDto) => {
    const d = drafts[f.name];
    if (!d || !d.dirty) return;
    setDraft(f.name, { saving: true, error: undefined });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name, value: d.value }),
      });
      const body = (await res.json().catch(() => ({}))) as { source?: FieldDto['source']; error?: string };
      if (res.ok) {
        setFields((fs) => fs?.map((x) => (x.name === f.name ? { ...x, source: body.source ?? x.source } : x)) ?? fs);
        setDraft(f.name, { dirty: false, saving: false, saved: true, error: undefined });
        toast(`${f.label} saved`, 'success');
        setTimeout(() => setDraft(f.name, { saved: false }), 1800);
      } else {
        // Surface WHY instead of silently leaving the button "unsaved" — a 400
        // "Unknown setting" means this worker predates the field (mid-deploy);
        // a 401 means the session lapsed. Don't make the operator guess.
        const why =
          res.status === 401
            ? 'Session expired — sign in again.'
            : body.error
              ? `${body.error} (HTTP ${res.status})`
              : `Save failed (HTTP ${res.status}).`;
        setDraft(f.name, { saving: false, error: why });
      }
    } catch {
      setDraft(f.name, { saving: false, error: 'Network error — not saved.' });
    }
  };

  // The label header (name + privileged icon + source pill) shared by every
  // control variant. `htmlFor` only applies to the text input variant.
  const fieldHeader = (f: FieldDto, htmlFor?: string) => (
    <label className={styles.fieldLabel} htmlFor={htmlFor}>
      <span className={styles.fieldName}>
        {f.label}
        {f.privilegedForActions ? (
          <ShieldAlert size={12} strokeWidth={2.4} aria-hidden className={styles.privIcon} />
        ) : null}
      </span>
      <span className={`${styles.source} mono`} data-src={f.source ?? 'none'}>
        {f.source ?? 'not set'}
      </span>
    </label>
  );

  const renderField = (f: FieldDto) => {
    // Boolean → switch. Reads the effective value (override or env), falling back
    // to the code default when nothing is set; saves 'true'/'false' on flip.
    if (f.control === 'toggle') {
      const on = f.value != null ? isTruthy(f.value) : !!f.boolDefault;
      return (
        <div key={f.name} className={styles.field}>
          {fieldHeader(f)}
          <div className={styles.toggleRow}>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={f.label}
              className={styles.toggle}
              data-on={on || undefined}
              onClick={() => commitValue(f.name, on ? 'false' : 'true')}
            >
              <span className={styles.toggleThumb} />
            </button>
            <span className={styles.toggleState}>{on ? 'On' : 'Off'}</span>
          </div>
        </div>
      );
    }

    // Numeric → slider + custom number box (the box accepts values past max).
    if (f.control === 'slider') {
      const current =
        f.value != null && f.value !== '' && Number.isFinite(Number(f.value))
          ? Number(f.value)
          : (f.numDefault ?? f.min ?? 0);
      return (
        <div key={f.name} className={styles.field}>
          {fieldHeader(f)}
          <SliderField field={f} initial={current} onCommit={(v) => commitValue(f.name, v)} />
        </div>
      );
    }

    const d = drafts[f.name] ?? { value: '', revealed: false, dirty: false };
    const masked = f.secret && !d.revealed;
    return (
      <div key={f.name} className={styles.field}>
        {fieldHeader(f, `set-${f.name}`)}
        <div className={styles.inputRow}>
          <input
            id={`set-${f.name}`}
            type={masked ? 'password' : 'text'}
            className={`${styles.input} ${f.secret ? 'mono' : ''}`}
            value={d.value}
            placeholder={
              f.secret
                ? d.revealed
                  ? ''
                  : f.source
                    ? '•••••• (set — eye to reveal)'
                    : (f.placeholder ?? '')
                : (f.placeholder ?? '')
            }
            onChange={(e) => setDraft(f.name, { value: e.target.value, dirty: true, error: undefined })}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={d.error ? true : undefined}
            aria-describedby={d.error ? `err-${f.name}` : undefined}
          />
          {f.secret ? (
            <IconButton
              variant="secondary"
              label={d.revealed ? 'Hide value' : 'Reveal value'}
              onClick={() => void onReveal(f)}
              disabled={!f.source && !d.dirty}
            >
              {d.revealed ? (
                <EyeOff size={15} strokeWidth={2.2} aria-hidden />
              ) : (
                <Eye size={15} strokeWidth={2.2} aria-hidden />
              )}
            </IconButton>
          ) : null}
          {f.secret && d.revealed && d.value ? (
            <IconButton
              variant="secondary"
              label="Copy value"
              onClick={() => {
                navigator.clipboard
                  .writeText(d.value)
                  .then(() => toast('Copied', 'success'))
                  .catch(() => toast('Copy blocked by the browser', 'error'));
              }}
            >
              <Copy size={15} strokeWidth={2.2} aria-hidden />
            </IconButton>
          ) : null}
          <Button
            variant="primary"
            onClick={() => void onSave(f)}
            disabled={!d.dirty}
            loading={d.saving}
          >
            {d.saved ? 'Saved' : 'Save'}
          </Button>
        </div>
        {d.revealed && d.revealedAt != null && f.secret ? (
          <p className={`${styles.fieldHint} mono tnum`}>
            Visible for {Math.max(0, REVEAL_SECONDS - Math.floor((now - d.revealedAt) / 1000))}s, then it hides again.
          </p>
        ) : null}
        {d.dirty ? <p className={styles.fieldHint}>Unsaved change</p> : null}
        {d.error ? (
          <p id={`err-${f.name}`} className={styles.fieldError} role="alert">
            {d.error}
          </p>
        ) : null}
      </div>
    );
  };

  if (fields == null) {
    return (
      <div className={styles.loading} aria-busy="true">
        <Skeleton height="1.1rem" width="40%" />
        <Skeleton height="2.4rem" />
        <Skeleton height="1.1rem" width="30%" />
        <Skeleton height="2.4rem" />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className={styles.loading}>
        <StateBlock
          kind="error"
          title="Settings did not load"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setFields(null);
                setLoadError(false);
                void load();
              }}
            >
              Retry
            </Button>
          }
        >
          The dashboard could not read its settings. Check that you are still signed in, then retry.
        </StateBlock>
      </div>
    );
  }

  return (
    <div className={styles.body}>
      <nav className={styles.nav} aria-label="Settings sections" ref={navRef}>
        <span className={styles.navIndicator} style={indicator} aria-hidden />
        {groups.map((g) => (
          <button
            key={g}
            type="button"
            className={styles.navItem}
            data-active={g === active || undefined}
            aria-current={g === active ? 'true' : undefined}
            onClick={() => setActive(g)}
          >
            {g}
          </button>
        ))}
      </nav>

      <div className={styles.content}>
        <p className={styles.intro}>
          These power the panels and the assistant. They override{' '}
          <code className="mono">.env.local</code> on the next probe. The eye reveals a current value
          after you re-confirm your password. Fields flagged{' '}
          <ShieldAlert size={12} strokeWidth={2.4} aria-hidden /> need an elevated token for the
          assistant to perform actions (see CREDENTIALS.md).
        </p>
        <h3 className={styles.sectionHeading}>{active}</h3>
        {fields
          .filter((f) => f.group === active && f.name !== 'ASSISTANT_MULTIPLIER_MODEL')
          .map(renderField)}
        {active === 'Assistant' ? (
          <AssistantSettings
            multiplierValue={fields.find((f) => f.name === 'ASSISTANT_MULTIPLIER_MODEL')?.value ?? ''}
            onSaveMultiplier={(v) => void saveValue('ASSISTANT_MULTIPLIER_MODEL', v)}
          />
        ) : null}
        {active === 'Security & sessions' ? <SessionsSettings /> : null}
        {active === 'Agent access' ? <AgentAccessSettings /> : null}
      </div>
    </div>
  );
}

/** A slider for a numeric setting, with a custom number box on the right. The
 *  slider is clamped to [min,max]; the number box accepts values PAST max (it
 *  just pins the slider at the end), so an owner can exceed a sensible ceiling
 *  on purpose. Saves are debounced so dragging doesn't hammer the endpoint. */
function SliderField({
  field,
  initial,
  onCommit,
}: {
  field: FieldDto;
  initial: number;
  onCommit: (value: string) => void;
}) {
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const step = field.step ?? 1;
  const [val, setVal] = useState(initial);
  const [text, setText] = useState(String(initial));
  const saveTimer = useRef<number | null>(null);

  // Re-seed if the canonical value changes underneath us (another save landed).
  useEffect(() => {
    setVal(initial);
    setText(String(initial));
  }, [initial]);

  const scheduleSave = (n: number) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => onCommit(String(n)), 350);
  };

  const onSlider = (raw: number) => {
    setVal(raw);
    setText(String(raw));
    scheduleSave(raw);
  };

  // On blur/Enter: parse, floor at min, allow above max (stored as typed).
  const commitText = () => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(val));
      return;
    }
    const next = Math.max(min, n);
    setVal(next);
    setText(String(next));
    scheduleSave(next);
  };

  const sliderVal = Math.min(max, Math.max(min, val));

  return (
    <div className={styles.sliderRow}>
      <input
        type="range"
        className={styles.slider}
        min={min}
        max={max}
        step={step}
        value={sliderVal}
        onChange={(e) => onSlider(Number(e.target.value))}
        aria-label={field.label}
      />
      <div className={styles.sliderNum}>
        <input
          type="number"
          className={styles.numInput}
          value={text}
          min={min}
          step={step}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          aria-label={`${field.label} value`}
        />
        {field.unit ? <span className={styles.sliderUnit}>{field.unit}</span> : null}
      </div>
      {field.zeroLabel && val === 0 ? (
        <span className={styles.sliderHint}>{field.zeroLabel}</span>
      ) : null}
    </div>
  );
}
