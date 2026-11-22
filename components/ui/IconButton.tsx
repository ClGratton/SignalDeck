import { forwardRef } from 'react';
import s from './ui.module.css';
import { cx } from './cx';
import type { ButtonProps } from './Button';

export type IconButtonProps = Omit<ButtonProps, 'size' | 'block'> & { label: string };

/** Square icon-only button. `label` is required (aria-label + title). 40px, 44px on touch/phone. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', loading, label, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(s.btn, s.icon, s[variant], loading && s.loading, className)}
      {...rest}
    >
      {loading ? <span className={s.spinner} aria-hidden="true" /> : children}
    </button>
  );
});
