import { useId } from 'react';
import s from './ui.module.css';
import { cx } from './cx';

type Common = { label: string; hint?: string; error?: string; className?: string };
type InputProps = Common & { as?: 'input' } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'>;
type AreaProps = Common & { as: 'textarea' } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>;
type SelectProps = Common & { as: 'select' } & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'className'>;

/** Labelled control. Error is linked via aria-describedby and announced (role=alert). */
export function Field(props: InputProps | AreaProps | SelectProps) {
  const { label, hint, error, className, as = 'input', ...rest } = props as Common & { as?: string } & Record<
    string,
    unknown
  >;
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  const shared = {
    id,
    className: s.input,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    ...rest,
  };
  const Tag = as as 'input';
  return (
    <div className={cx(s.field, error && s.invalid, className)}>
      <label htmlFor={id} className={s.fieldLabel}>
        {label}
      </label>
      <Tag {...(shared as React.InputHTMLAttributes<HTMLInputElement>)} />
      {hint && (
        <span id={hintId} className={s.fieldHint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={errId} role="alert" className={s.fieldError}>
          {error}
        </span>
      )}
    </div>
  );
}
