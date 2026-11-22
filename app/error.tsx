'use client';

import Link from 'next/link';
import { Button, StateBlock } from '@/components/ui';
import styles from './status/status.module.css';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className={styles.page}>
      <div className={styles.header} />
      <div className={styles.main}>
        <StateBlock
          kind="error"
          title="Something went wrong"
          details={error.digest ? `Reference: ${error.digest}` : undefined}
          action={
            <div className={styles.errActions}>
              <Button variant="primary" onClick={reset}>
                Try again
              </Button>
              <Link href="/" className={styles.homeLink}>
                Landing page
              </Link>
            </div>
          }
        >
          The page failed to load. Nothing was changed. Try again, or go back.
        </StateBlock>
      </div>
    </main>
  );
}
