/**
 * Automation defaults — the opening values for every launch surface.
 *
 * The six that govern a RUN are rendered by `RunSetup` in `defaults` mode: the
 * same component, the same words and the same order as the launch dialog and
 * the run page's controls, so "the default" and "this launch" are visibly the
 * same form rather than two forms that happen to agree. Each still saves as
 * its own key the moment it changes (`POST /api/prefs` merges server-side —
 * two tabs flipping different knobs must not overwrite each other).
 *
 * What stays declared here is what is NOT a run setting: the two knobs that
 * govern the console's own scheduling rather than what a session may do.
 *
 * State is rendered from `/api/state`, the same discipline as the
 * notifications card: a preference that governs a server process is shown from
 * what that process actually holds, never from a local copy of the intention.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, useConsoleState } from '@/lib/queries';
import { api, automationPrefs } from '@/lib/api';
import { Button, Card, CardBody, CardHeader, CardTitle, Skeleton, toast } from '@/components/ui';
import { RunSetup } from '@/features/run-setup/run-setup';

export function AutomationCard() {
  const client = useQueryClient();
  const { data: state, isPending } = useConsoleState();

  const save = useMutation({
    // One key at a time, merged server-side — two tabs flipping different
    // knobs must not overwrite each other.
    mutationFn: (patch: Record<string, unknown>) => api.savePrefs(patch),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.state() });
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (isPending && !state) return <Skeleton className="h-64" />;

  const prefs = automationPrefs(state);
  const busy = save.isPending;

  const row = 'flex flex-wrap items-center justify-between gap-2';
  const onOff = (value: boolean, key: string, on = 'On', off = 'Off') => (
    <Button size="sm" aria-pressed={value} disabled={busy} onClick={() => save.mutate({ [key]: !value })}>
      {value ? on : off}
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {/* The launch form itself, in the mode that edits the defaults every
            other mode opens on. No submit button: a page of preferences has
            no "Save", and each field is its own patch. */}
        <RunSetup mode="defaults" />

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Continue runs a recovery fixed</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              When a recovery session ends and the board reads fixed, the run resumes by itself — manual
              Fix-with-AI sessions included.
            </span>
          </span>
          {onOff(prefs.autoContinueRecovery, 'autoContinueRecovery')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Repository guard</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              Queue runs whose repositories overlap. Off: overlapping runs may start at once, and a
              work-branch run sharing a repo is steered into a git worktree.
            </span>
          </span>
          {onOff(prefs.repoGuard, 'repoGuard')}
        </div>

        <p className="text-2xs text-ink-muted">
          Stored with the console — these are the opening values for every launch dialog; each launch can
          still override them for itself.
        </p>
      </CardBody>
    </Card>
  );
}
