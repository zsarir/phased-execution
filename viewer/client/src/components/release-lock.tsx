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
import { plural } from '@/lib/format';
import { Button, toast } from '@/components/ui';

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
  release: (slug: string, phase: number) => Promise<boolean>;
  releaseAllExpired: () => Promise<number>;
  busy: boolean;
} {
  const [busy, setBusy] = useState(false);
  const after = useAfterRelease();

  const release = useCallback(async (slug: string, phase: number) => {
    setBusy(true);
    try {
      const result = await api.releaseLock(slug, phase);
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
