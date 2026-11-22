import s from './ui.module.css';
import { cx } from './cx';

/** One component for empty / error / offline. Raw backend text goes in `details`. */
export function StateBlock({
  kind = 'empty',
  title,
  children,
  action,
  details,
  className,
}: {
  kind?: 'empty' | 'error' | 'offline';
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  details?: string;
  className?: string;
}) {
  const glyph = kind === 'error' ? '!' : kind === 'offline' ? '~' : '—';
  return (
    <div
      className={cx(s.state, kind === 'error' && s['state-error'], className)}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <span className={s.stateIcon} aria-hidden="true">
        {glyph}
      </span>
      <div className={s.stateTitle}>{title}</div>
      {children && <p className={s.stateText}>{children}</p>}
      {details && (
        <details className={s.details}>
          <summary>Details</summary>
          <pre>{details}</pre>
        </details>
      )}
      {action}
    </div>
  );
}
