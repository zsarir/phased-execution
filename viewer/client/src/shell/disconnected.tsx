import { CloudOff, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui';
import { RouteGlyph } from '@/shell/brand';

/**
 * What the app is when it cannot reach the console.
 *
 * This screen only exists because the shell is precached, and it is the reason
 * precaching the shell is safe. Opening offline used to be a blank tab; now it
 * is the app, immediately, saying exactly one true thing: it cannot see the
 * board.
 *
 * What it deliberately does not do is show a board. Every phase status, ready
 * queue and approval count in this console is a claim about a repository that
 * is being edited by sessions right now — cached and re-presented, it would be
 * indistinguishable from live and wrong within a minute. "Departed" for a phase
 * that has since gone blocked is worse than nothing, because nothing prompts a
 * reload and a stale board does not.
 */
export function Disconnected({
  online,
  detail,
  onRetry,
  retrying = false,
}: {
  online: boolean;
  detail?: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const Icon = online ? CloudOff : WifiOff;
  return (
    <div className="grid min-h-dvh place-items-center bg-ground p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div className="flex items-center gap-2 text-ink-muted">
          <RouteGlyph size={22} />
          <span className="font-display text-lg text-ink">Phase Console</span>
        </div>

        <Icon size={30} className="text-ink-faint" aria-hidden />

        <h1 className="font-display text-2xl text-ink">
          {online ? 'The console is not answering' : "You're offline"}
        </h1>

        <p className="text-sm text-ink-muted">
          {online
            ? 'The app loaded from this device, but the server behind it did not respond.'
            : 'The app loaded from this device. Reaching the console needs a network.'}
          {' '}
          The board is not shown because it would be out of date, and an out-of-date
          board looks exactly like a current one.
        </p>

        <Button variant="action" onClick={onRetry} disabled={retrying}>
          <RefreshCw size={15} className={retrying ? 'animate-spin' : undefined} aria-hidden />
          {retrying ? 'Trying…' : 'Try again'}
        </Button>

        {detail && (
          <p className="max-w-full truncate font-mono text-2xs text-ink-faint" title={detail}>
            {detail}
          </p>
        )}
      </div>
    </div>
  );
}
