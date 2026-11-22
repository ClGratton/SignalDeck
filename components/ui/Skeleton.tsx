import s from './ui.module.css';
import { cx } from './cx';

/** Placeholder block. Decorative; put aria-busy on the container. */
export function Skeleton({
  width = '100%',
  height = '1em',
  className,
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
}) {
  return <span aria-hidden="true" className={cx(s.skeleton, className)} style={{ width, height }} />;
}
