import Link from 'next/link';
import { StateBlock } from '@/components/ui';
import styles from './status/status.module.css';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <main id="main" className={styles.page}>
      <div className={styles.header} />
      <div className={styles.main}>
        <StateBlock
          title="Page not found"
          action={
            <Link href="/" className={styles.homeLink}>
              Back to the landing page
            </Link>
          }
        >
          That address does not exist, or it needs a session. Check the link or head back.
        </StateBlock>
      </div>
    </main>
  );
}
