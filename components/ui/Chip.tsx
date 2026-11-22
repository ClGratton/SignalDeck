import s from './ui.module.css';
import { cx } from './cx';

type ChipProps = {
  tone?: 'neutral' | 'ok' | 'warn' | 'down' | 'accent';
  /** Uppercase mono label style (the 11px floor). */
  mono?: boolean;
  /** Leading status dot (use with text; colour is never the only cue). */
  dot?: boolean;
  /** Makes the chip a toggle button. */
  pressed?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  className?: string;
  children: React.ReactNode;
};

export function Chip({ tone = 'neutral', mono, dot, pressed, onClick, className, children }: ChipProps) {
  const cls = cx(s.chip, mono && s.chipMono, tone !== 'neutral' && s[`tone-${tone}`], className);
  const inner = (
    <>
      {dot && <span className={s.dot} aria-hidden="true" />}
      {children}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} aria-pressed={pressed} onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <span className={cls}>{inner}</span>;
}
