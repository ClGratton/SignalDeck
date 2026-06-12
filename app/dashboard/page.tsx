import { lab } from '@/lib/config';
import { peekConsoleSnapshot } from '@/lib/console';
import { getProviderKey } from '@/lib/assistant/keys';
import { ConsoleShell } from '@/components/console/ConsoleShell';
import type { AssistantProvider } from '@/lib/assistant/types';

export const metadata = {
  title: `Console — ${lab.name}`,
};

// Protected by the middleware. The page itself must render instantly: the
// snapshot is PEEKED (never awaited — see CLAUDE.md); the client poller fills
// in live data within a second on a cold cache.
export default function DashboardPage() {
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
