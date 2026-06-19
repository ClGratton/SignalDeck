'use client';

// Settings → Security & sessions: the live device list (revoke any) plus the QR
// handoff that signs a phone in from this already-authenticated desktop. The
// timeout / concurrency / 2FA knobs above it are plain config fields.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone, Monitor, LogOut, QrCode, RefreshCw } from 'lucide-react';
import styles from './settings.module.css';

interface SessionView {
  id: string;
  label: string;
  ip: string;
  issuedAt: number;
  lastSeen: number;
  current: boolean;
}

interface QrState {
  svg: string;
  code: string;
  expiresAt: number;
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

export function SessionsSettings() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [qr, setQr] = useState<QrState | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions', { cache: 'no-store' });
      if (res.ok) {
        const d = (await res.json()) as { sessions: SessionView[] };
        setSessions(d.sessions);
      } else {
        setSessions([]);
      }
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the device list fresh while the panel is open: a sign-in on another
  // device (e.g. a QR redeem on a phone) should appear on its own, without
  // closing and reopening Settings. Poll lightly + refresh when the tab regains
  // focus (covers coming back from the phone).
  useEffect(() => {
    const id = setInterval(() => void load(), 5000);
    const refresh = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  // Tick once a second only while a QR is live (for its countdown).
  useEffect(() => {
    if (!qr) {
      if (tickRef.current) clearInterval(tickRef.current);
      return;
    }
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [qr]);

  const revoke = useCallback(
    async (id: string) => {
      await fetch('/api/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => {});
      void load();
    },
    [load],
  );

  const revokeOthers = useCallback(async () => {
    await fetch('/api/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ others: true }),
    }).catch(() => {});
    void load();
  }, [load]);

  const showQr = useCallback(async () => {
    setQrBusy(true);
    try {
      const res = await fetch('/api/auth/handoff', { method: 'POST' });
      if (res.ok) {
        // The route returns the SVG under `qrSvg`; map it onto QrState.svg (a
        // mismatch here is what left the QR box blank — the timer still ran
        // because `expiresAt`/`code` matched).
        const d = (await res.json()) as { qrSvg: string; code: string; expiresAt: number };
        setQr({ svg: d.qrSvg, code: d.code, expiresAt: d.expiresAt });
        setNow(Date.now());
      }
    } catch {
      /* leave the QR closed */
    } finally {
      setQrBusy(false);
    }
  }, []);

  const others = (sessions ?? []).filter((s) => !s.current).length;
  const secondsLeft = qr ? Math.max(0, Math.ceil((qr.expiresAt - now) / 1000)) : 0;
  const qrExpired = qr != null && secondsLeft <= 0;

  return (
    <div className={styles.assistantExtras}>
      <section>
        <div className={styles.sessionHead}>
          <h3 className={styles.sessionTitle}>Active devices</h3>
          {others > 0 ? (
            <button type="button" className={styles.linkDanger} onClick={() => void revokeOthers()}>
              Sign out other devices
            </button>
          ) : null}
        </div>
        <p className={styles.subnote}>
          Every device with a live session. Removing one signs it out on its next request.
        </p>
        <div className={styles.deviceList}>
          {sessions == null ? (
            <p className={styles.muted}>Loading…</p>
          ) : sessions.length === 0 ? (
            <p className={styles.muted}>No active sessions.</p>
          ) : (
            sessions.map((s) => {
              const mobile = /iOS|Android/.test(s.label);
              return (
                <div key={s.id} className={styles.sessionRow}>
                  {mobile ? (
                    <Smartphone size={16} strokeWidth={2} aria-hidden className={styles.sessionIcon} />
                  ) : (
                    <Monitor size={16} strokeWidth={2} aria-hidden className={styles.sessionIcon} />
                  )}
                  <div className={styles.sessionMeta}>
                    <span className={styles.sessionLabel}>
                      {s.label}
                      {s.current ? <span className={styles.badge}>this device</span> : null}
                    </span>
                    <span className={`${styles.sessionSub} mono`}>
                      {s.ip} · active {timeAgo(s.lastSeen)}
                    </span>
                  </div>
                  {s.current ? null : (
                    <button
                      type="button"
                      className={styles.iconDanger}
                      onClick={() => void revoke(s.id)}
                      aria-label={`Sign out ${s.label}`}
                      title="Sign out this device"
                    >
                      <LogOut size={15} strokeWidth={2.2} aria-hidden />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      <section>
        <h3 className={styles.sessionTitle}>Sign in another device</h3>
        <p className={styles.subnote}>
          Scan this from your phone to sign it in — no password needed. The code is single-use and
          expires in 60 seconds.
        </p>
        {qr && !qrExpired ? (
          <div className={styles.qrBox}>
            <div className={styles.qrImg} aria-hidden dangerouslySetInnerHTML={{ __html: qr.svg }} />
            <p className={styles.subnote}>
              Expires in <strong>{secondsLeft}s</strong>. Open your phone camera and point it at the
              code.
            </p>
            <button
              type="button"
              className={styles.qrLink}
              onClick={() => void showQr()}
              disabled={qrBusy}
            >
              <RefreshCw size={13} strokeWidth={2.2} aria-hidden /> New code
            </button>
          </div>
        ) : (
          <button type="button" className={styles.saveBtn} onClick={() => void showQr()} disabled={qrBusy}>
            <QrCode size={15} strokeWidth={2.2} aria-hidden style={{ marginRight: 6, verticalAlign: '-2px' }} />
            {qrBusy ? 'Generating…' : qrExpired ? 'Show a new QR code' : 'Show QR code'}
          </button>
        )}
      </section>
    </div>
  );
}
