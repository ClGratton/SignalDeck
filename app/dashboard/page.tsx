import { redirect } from 'next/navigation';
import { lab } from '@/lib/config';
import { peekConsoleSnapshot } from '@/lib/console';
import { getProviderKey } from '@/lib/assistant/keys';
import { hasValidSession } from '@/lib/session';
import { ConsoleShell } from '@/components/console/ConsoleShell';
import type { AssistantProvider } from '@/lib/assistant/types';

export const metadata = {
  title: `Console — ${lab.name}`,
};

// The middleware verifies the token at the door (edge-safe); this page is where
// the session REGISTRY is enforced on navigation — hasValidSession() applies the
// idle/absolute timeouts + concurrent eviction and refreshes activity. It's a
// fast local check (no backend probe), so the "render instantly" rule still
// holds: the snapshot is PEEKED (never awaited — see CLAUDE.md).
export default async function DashboardPage() {
  if (!(await hasValidSession())) redirect('/login?from=/dashboard');
  // Initial hint only — the sidebar refines this from /api/assistant/models
  // (which also covers keys stored through the UI after this render).
  const assistantProvider: AssistantProvider | null = getProviderKey('anthropic')
    ? 'anthropic'
    : getProviderKey('gemini')
      ? 'gemini'
      : null;

  return (
    <ConsoleShell
      initial={peekConsoleSnapshot()}
      assistantProvider={assistantProvider}
      twoFactor={Boolean(process.env.TWO_FACTOR_SECRET)}
    />
  );
}
