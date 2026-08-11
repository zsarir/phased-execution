/**
 * Automation defaults — the opening values for every launch surface.
 *
 * Five knobs, all server-side preferences: they govern what a RUN does, so
 * they live with the console process (`~/.config/phase-console/config.json`),
 * not with a browser tab. Each launch dialog seeds from them and can override
 * for itself — this card is where "for all plans" is said once.
 *
 * State is rendered from `/api/state`, the same discipline as the
 * notifications card: a preference that governs a server process is shown from
 * what that process actually holds, never from a local copy of the intention.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, useConsoleState } from '@/lib/queries';
import { api, automationPrefs } from '@/lib/api';
import { Button, Card, CardBody, CardHeader, CardTitle, Skeleton, toast } from '@/components/ui';

export function AutomationCard() {
  const client = useQueryClient();
  const { data: state, isPending } = useConsoleState();

  const save = useMutation({
    // One key at a time, merged server-side — two tabs flipping different
    // knobs must not overwrite each other.
    mutationFn: (patch: Record<string, unknown>) => api.savePrefs(patch),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: keys.state() }); },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (isPending && !state) return <Skeleton className="h-64" />;

  const prefs = automationPrefs(state);
  const defaultSkills = state?.defaultSkills ?? [];
  const busy = save.isPending;

  const row = 'flex flex-wrap items-center justify-between gap-2';
  const onOff = (value: boolean, key: string, on = 'On', off = 'Off') => (
    <Button
      size="sm"
      aria-pressed={value}
      disabled={busy}
      onClick={() => save.mutate({ [key]: !value })}
    >
      {value ? on : off}
    </Button>
  );

  return (
    <Card>
      <CardHeader><CardTitle>Automation</CardTitle></CardHeader>
      <CardBody className="flex flex-col gap-3">
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Attach default skills to new sessions</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              {defaultSkills.length
                ? <>This machine's list: {defaultSkills.map((s) => <code key={s} className="mr-1">{s}</code>)}</>
                : 'This machine has no default skills configured.'}
            </span>
          </span>
          {onOff(prefs.attachDefaultSkills, 'attachDefaultSkills')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Turn the QA gate on for new runs</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              Each finished phase then waits for an independent review before its dependents run.
            </span>
          </span>
          {onOff(prefs.qaByDefault, 'qaByDefault')}
        </div>

        <div className={row}>
          <label htmlFor="automation-git-mode" className="text-sm text-ink">Branch</label>
          <select
            id="automation-git-mode"
            value={prefs.gitMode}
            disabled={busy}
            onChange={(event) => save.mutate({ gitMode: event.target.value })}
            className="min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-sm text-ink"
          >
            <option value="default-branch">Work on the current branch</option>
            <option value="new-branch">Create a work branch per run</option>
          </select>
        </div>

        {prefs.gitMode === 'new-branch' ? (
          <div className={row}>
            <span className="min-w-0">
              <span className="text-sm text-ink">Open a PR when the plan completes</span>
              <span className="mt-0.5 block text-2xs text-ink-muted">
                The final phase pushes the work branch and opens the PR — after one approval tap.
              </span>
            </span>
            {onOff(prefs.openPrOnComplete, 'openPrOnComplete')}
          </div>
        ) : (
          <p className="text-2xs text-ink-faint">
            PR-on-completion applies to work-branch runs; pick “Create a work branch per run” to
            use it.
          </p>
        )}

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Auto-recover halted runs</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A halt an agent can clear (failed verification, missing handoff, a crashed phase)
              launches the fix agent by itself — at most 2 tries per phase, 5 per run, never the
              same failure twice, and never for the halts only you can clear.
            </span>
          </span>
          {onOff(prefs.autoRecoverByDefault, 'autoRecoverByDefault')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Continue runs a recovery fixed</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              When a recovery session ends and the board reads fixed, the run resumes by itself —
              manual Fix-with-AI sessions included.
            </span>
          </span>
          {onOff(prefs.autoContinueRecovery, 'autoContinueRecovery')}
        </div>

        <div className={row}>
          <span className="min-w-0">
            <label htmlFor="automation-mcp-policy" className="text-sm text-ink">
              When an MCP server is unavailable
            </label>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A plan or a single phase can still demand its servers — this is only where every run
              starts.
            </span>
          </span>
          <select
            id="automation-mcp-policy"
            value={prefs.mcpPolicy}
            disabled={busy}
            onChange={(event) => save.mutate({ mcpPolicy: event.target.value })}
            className="min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-sm text-ink"
          >
            <option value="continue">Continue and warn</option>
            <option value="require">Park the phase</option>
          </select>
        </div>

        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Repository guard</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              Queue runs whose repositories overlap. Off: overlapping runs may start at once, and
              a work-branch run sharing a repo is steered into a git worktree.
            </span>
          </span>
          {onOff(prefs.repoGuard, 'repoGuard')}
        </div>

        <p className="text-2xs text-ink-muted">
          Stored with the console — these are the opening values for every launch dialog; each
          launch can still override them for itself.
        </p>
      </CardBody>
    </Card>
  );
}
