import { redirect } from 'next/navigation';
import { lab } from '@/lib/config';
import { hasValidSession } from '@/lib/session';
import { ThemeToggle } from '@/components/ThemeToggle';
import { LoginForm } from './LoginForm';
import styles from './login.module.css';

export const metadata = {
  title: `Authenticate — ${lab.name}`,
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const dest = from && from.startsWith('/') && !from.startsWith('//') ? from : '/dashboard';
  const twoFactor = Boolean(process.env.TWO_FACTOR_SECRET);

  // Already signed in: skip the form entirely. Successful sign-in removes
  // /login from history (see LoginForm), so this never creates a back-trap —
  // it only catches direct visits, which belong on the console.
  if (await hasValidSession()) redirect(dest);

  return (
    <main className={styles.wrap}>
      <span className={styles.themeSlot}>
        <ThemeToggle />
      </span>
      <div className={styles.card}>
        {/* Reserved slot the persistent BrandNav logo docks into (it becomes the
            back button). The card has no logo of its own. */}
        <span className={styles.brandDock} data-brand-dock aria-hidden />
        <h1 className={styles.title}>Authenticate</h1>
        <p className={styles.sub}>
          {twoFactor
            ? 'Sign in with your password and authenticator code to reach the operator console.'
            : 'Sign in to reach the operator console.'}
        </p>
        <LoginForm from={dest} twoFactor={twoFactor} />
      </div>
    </main>
  );
}
