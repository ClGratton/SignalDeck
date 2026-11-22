import { forwardRef } from 'react';
import s from './ui.module.css';
import { cx } from './cx';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  loading?: boolean;
  block?: boolean;
};

/** Loading keeps the label and width (no jump); the spinner is prepended inline. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(s.btn, s[variant], size === 'lg' && s.lg, block && s.block, loading && s.loading, className)}
      {...rest}
    >
      {loading && <span className={s.spinner} aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
});
