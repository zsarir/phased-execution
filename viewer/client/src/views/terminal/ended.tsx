/**
 * What a session page says when the session is over.
 *
 * Both pages used to answer this the same way and the answer was silence: a URL
 * naming a session that was not in the list navigated away from itself. On a
 * phone that reads as a tap that did nothing — you opened a notification, the
 * app flickered, and you are on the launcher with no idea whether the thing you
 * were told about succeeded.
 *
 * Two states, two panels, shared by the shell page and the agent page so they
 * cannot drift:
 *
 *  - **ended** — the record is still here. What it exited with, when, and (for a
 *    claude session) the `--resume` id that is the whole point of keeping it.
 *  - **gone** — the record is not here: dismissed, or retired after a day. Said
 *    plainly, with the way back, rather than a redirect.
 *
 * ⚠️ **Imported by the two pages through `./pane`, never directly.** The
 * terminal and agent routes share one lazy chunk, and the bundler names that
 * chunk after the module the routes import — its *facade*. Importing this file
 * from both routes made it a second facade and renamed the chunk from `pane-*`
 * to `ended-*`, which silently escaped `globIgnores` in `vite.config.ts` and put
 * 346 KB of xterm into the service worker's precache for every visitor.
 * `scripts/check-dist.mjs` caught it. Re-exporting from `pane.tsx` keeps one
 * facade and one name; do not "tidy" the pages to import from here.
 */

import { RotateCcw, Trash2 } from 'lucide-react';
import type { TerminalSession } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { navigate } from '@/router';
import { Button, CopyButton, Empty } from '@/components/ui';

/** How it ended, in words rather than a number a reader has to interpret. */
export function exitSummary(session: TerminalSession): string {
  const { code = 0, signal, closedByOperator } = session.exited ?? {};
  if (closedByOperator) return 'you closed it';
  if (signal) return `killed by signal ${signal}`;
  return code === 0 ? 'exited cleanly' : `exited with code ${code}`;
}

export function EndedBanner({
  session,
  atCap,
  onResume,
  onDismiss,
}: {
  session: TerminalSession;
  atCap: boolean;
  /** Agent sessions only — a shell has no conversation to pick up. */
  onResume?: (resumeId: string) => void;
  onDismiss: (id: string) => void;
}) {
  const resumeId = onResume ? session.meta?.claudeSessionId : undefined;
  const failed = session.exited?.code !== 0 || session.exited?.signal != null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-surface px-3 py-2 text-sm text-ink-muted">
      <span className={failed ? 'text-blocked' : undefined}>
        This session {exitSummary(session)}
        {session.exitedAt ? ` ${relativeTime(session.exitedAt)}` : ''}.
      </span>
      {/* The scrollback below is still real and still readable — that is why the
          record outlives the process rather than being replaced by a notice. */}
      {resumeId && (
        <>
          <Button
            size="sm"
            disabled={atCap}
            title={atCap ? 'Close a live session first' : 'Start a new session that continues this conversation'}
            onClick={() => onResume?.(resumeId)}
          >
            <RotateCcw size={14} aria-hidden /> Resume here
          </Button>
          <CopyButton text={`claude --resume ${resumeId}`} label="Copy resume command" />
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto"
        onClick={() => onDismiss(session.id)}
        title="Remove this ended session from the list"
      >
        <Trash2 size={14} aria-hidden /> Dismiss
      </Button>
    </div>
  );
}

export function SessionGone({ kind }: { kind: 'shell' | 'claude' }) {
  const page = kind === 'claude' ? 'agent' : 'terminal';
  return (
    <div className="grid flex-1 place-items-center p-4">
      <Empty
        title="That session is not here any more"
        body={
          <>
            It was dismissed, or it ended more than a day ago and its record was retired.
            Sessions themselves are not timed out — a running one stops only when you close it or
            when the console does.
          </>
        }
        action={
          <Button size="sm" onClick={() => navigate(page)}>
            {kind === 'claude' ? 'Start a new session' : 'Back to the terminal'}
          </Button>
        }
      />
    </div>
  );
}
