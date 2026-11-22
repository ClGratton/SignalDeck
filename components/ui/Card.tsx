import s from './ui.module.css';
import { cx } from './cx';

type CardProps = React.HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'article';
  title?: string;
  elevation?: 'flat' | 'raised' | 'default';
};

export function Card({ as: Tag = 'div', title, elevation = 'default', className, children, ...rest }: CardProps) {
  return (
    <Tag
      className={cx(s.card, elevation === 'flat' && s.cardFlat, elevation === 'raised' && s.cardRaised, className)}
      {...rest}
    >
      {title && <h3 className={s.cardTitle}>{title}</h3>}
      {children}
    </Tag>
  );
}
