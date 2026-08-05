/**
 * Releasing a stale claim, from wherever you noticed it.
 *
 * A lock is seen in three places — the dashboard's "stale claims" card, the
 * Statistics locks list, and the phase panel — and until now only one of them
 * offered anything, a dialog that demanded the owner be typed from memory. The
 * owner lives in the lock file; the server reads it (`Service.releaseLock`), so
 * these buttons carry no owner at all.
 *
 * Shared rather than written three times because the *rules* are shared and
 * subtle: a live lease is refused by the server with a 409, which surfaces here
 * as the refusal it is rather than a generic failure; a release that reports
 * "already free" is a success; and every one of them needs `--allow-writes`,
 * with the reason said out loud when the flag is off rather than a button that
 * silently does nothing.
 */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Unlock } from 'lucide-react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { countdown, plural, relativeTime } from '@/lib/format';
import { AlertDialog, AlertDialogContent, AlertDialogTrigger, Button, toast } from '@/components/ui';

const OFF_HINT = 'Writes are disabled. Restart the console with --allow-writes to release a claim.';

/** Everything a release touches: the board, the portfolio, the plan's own detail. */
function useAfterRelease() {
  const client = useQueryClient();
  return useCallback((slug?: string) => {
    void client.invalidateQueries({ queryKey: keys.plans() });
    void client.invalidateQueries({ queryKey: keys.stats() });
    if (slug) void client.invalidateQueries({ queryKey: keys.plan(slug) });
  }, [client]);
}

export function useReleaseLock(): {
  release: (slug: string, phase: number, force?: boolean) => Promise<boolean>;
  releaseAllExpired: () => Promise<number>;
  busy: boolean;
} {
  const [busy, setBusy] = useState(false);
  const after = useAfterRelease();

  const release = useCallback(async (slug: string, phase: number, force = false) => {
    setBusy(true);
    try {
      const result = await api.releaseLock(slug, phase, force);
      toast(
        result.owner
          ? `Released ${slug} P${phase} — it was held by ${result.owner}`
          : `${slug} P${phase} was already free`,
        'ok',
      );
      return true;
    } catch (error) {
      // The 409 refusal carries its own sentence ("… is still working this
      // phase"), so this is the server's words, not a substitute for them.
      toast((error as Error).message, 'warn');
      return false;
    } finally {
      setBusy(false);
      after(slug);
    }
  }, [after]);

  const releaseAllExpired = useCallback(async () => {
    setBusy(true);
    try {
      const { results, released } = await api.releaseExpiredLocks();
      const failed = results.filter((r) => !r.ok);
      if (!results.length) toast('No claim has expired.', 'ok');
      // Per-lock, always: "3 released" over a batch where one refused is the
      // report that hides the only thing worth reading.
      else if (failed.length) {
        toast(
          `Released ${released} of ${results.length} — ${failed
            .map((r) => `${r.slug} P${r.phase}: ${r.detail ?? 'refused'}`)
            .join('; ')}`,
          'warn',
        );
      } else toast(`Released ${plural(released, 'stale claim')}.`, 'ok');
      return released;
    } catch (error) {
      toast((error as Error).message, 'error');
      return 0;
    } finally {
      setBusy(false);
      after();
    }
  }, [after]);

  return { release, releaseAllExpired, busy };
}

export function ReleaseStaleButton({
  slug,
  phase,
  allowWrites = true,
  label = 'Release stale claim',
  onDone,
}: {
  slug: string;
  phase: number;
  allowWrites?: boolean;
  label?: string;
  onDone?: () => void;
}) {
  const { release, busy } = useReleaseLock();
  return (
    <Button
      size="sm"
      disabled={!allowWrites || busy}
      title={allowWrites ? `Release the phase ${phase} claim on ${slug}` : OFF_HINT}
      onClick={() => void release(slug, phase).then(() => onDone?.())}
    >
      <Unlock size={13} aria-hidden />
      {label}
    </Button>
  );
}

/**
 * Taking a claim whose lease is still running.
 *
 * The console refused this for good reason: a live lease means a session is
 * working, and two sessions on one phase is how they overwrite each other. But
 * a live claim now BLOCKS a run, and a block with no way past it is a dead end
 * — the holder is sometimes a session that died without releasing, and telling
 * someone to go find a terminal is not an answer a console gets to give.
 *
 * So: possible, never easy. An `AlertDialog` — no dismiss corner, no
 * outside-click close — that names the holder, the machine and the time left,
 * and says what it costs. The server audits every forced release.
 */
export function ForceReleaseButton({
  slug,
  phase,
  lock,
  allowWrites = true,
  onDone,
}: {
  slug: string;
  phase: number;
  lock: { owner: string; host?: string; leaseUntil?: number; claimedAt?: number };
  allowWrites?: boolean;
  onDone?: () => void;
}) {
  const { release, busy } = useReleaseLock();
  const left = countdown(lock.leaseUntil);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          disabled={!allowWrites || busy}
          title={allowWrites ? `Release the phase ${phase} claim held by ${lock.owner}` : OFF_HINT}
        >
          <Unlock size={13} aria-hidden />
          Release the claim
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        title={`Phase ${phase} is claimed`}
        destructive
        confirmLabel="Release the claim anyway"
        onConfirm={() => void release(slug, phase, true).then(() => onDone?.())}
        description={
          <>
            <span className="block font-mono text-xs text-ink">
              {lock.owner}{lock.host ? ` on ${lock.host}` : ''}
            </span>
            <span className="mt-1 block">
              {lock.claimedAt ? `Claimed ${relativeTime(lock.claimedAt)}` : 'Claimed'}
              {left && left !== '—' ? ` · the lease runs ${left} more.` : '.'}
            </span>
            <span className="mt-2 block">
              Booting a second session into this phase is how two agents overwrite each other.
              Release it only if you know that session has stopped.
            </span>
          </>
        }
      />
    </AlertDialog>
  );
}

export function ReleaseAllStaleButton({
  count,
  allowWrites = true,
  onDone,
}: {
  count: number;
  allowWrites?: boolean;
  onDone?: () => void;
}) {
  const { releaseAllExpired, busy } = useReleaseLock();
  if (count < 1) return null;
  return (
    <Button
      size="sm"
      disabled={!allowWrites || busy}
      title={allowWrites ? `Release all ${count} expired claims` : OFF_HINT}
      onClick={() => void releaseAllExpired().then(() => onDone?.())}
    >
      <Unlock size={13} aria-hidden />
      {count === 1 ? 'Release it' : `Release all ${count}`}
    </Button>
  );
}
