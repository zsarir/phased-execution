/**
 * The directory picker — the one view that renders *instead of* the shell,
 * because until a root is open there is nothing to navigate to.
 *
 * Phase 2 left this a path-in form, deliberately: a console whose only way to
 * open a directory is a screen saying "Phase 5 builds this" cannot be used on a
 * machine that has not already been set up. This is the real thing — recents,
 * a browsable tree, and a live verdict on whatever path is in the box.
 *
 * The verdict is the point. `checkRoot` answers *why* a directory is not a
 * source (no `docs/plans`, no such directory) and how much is in one when it
 * is, so Open is enabled by a fact rather than by hope.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, Folder, Home } from 'lucide-react';
import { api } from '@/lib/api';
import { useConsoleState, useDirListing, useRootCheck } from '@/lib/queries';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  Empty,
  Skeleton,
  toast,
} from '@/components/ui';
import { navigate } from '@/app/router';

export default function SourceView() {
  const { data: state } = useConsoleState();
  const client = useQueryClient();

  const [path, setPath] = useState(state?.root?.path ?? '');
  const [browsePath, setBrowsePath] = useState(state?.root?.path ?? '');

  const { data: listing, isPending: listingPending } = useDirListing(browsePath);
  const { data: check } = useRootCheck(path);

  // The server resolves `~`, `.` and a relative path into a real one, so the box
  // shows what was actually walked to rather than what was typed. Keyed on the
  // listing's own path: following it unconditionally would stamp the previous
  // directory's answer back over every keystroke.
  useEffect(() => {
    if (listing?.path && listing.path !== browsePath) setPath(listing.path);
  }, [listing?.path, browsePath]);

  const open = useMutation({
    mutationFn: (target: string) => api.openRoot(target),
    onSuccess: async (result) => {
      if (!result.check?.ok) {
        toast(result.check?.reason ?? 'Could not open that directory', 'error');
        return;
      }
      await client.invalidateQueries();
      toast(`Opened ${result.check.label}`);
      navigate('plans');
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const walkTo = (target: string) => {
    setBrowsePath(target);
    setPath(target);
  };
  // A pinned console serves one project and will answer 409 to any other. The
  // picker still renders — hiding it would leave someone who navigated here
  // staring at nothing — but Open is off, and the banner says which console
  // they are looking at and what to run instead. Discovering the refusal by
  // pressing a button and reading a toast is strictly worse.
  const pinned = state?.instance?.pinned === true;
  const canOpen = Boolean(check?.ok) && !open.isPending && !pinned;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-5">
        <h1 className="font-display text-3xl leading-none">Choose a source directory</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Point the console at a repository that holds <code className="text-ink">docs/plans</code>. A{' '}
          <code className="text-ink">docs/handoffs</code> folder beside it is read too, when there is one.
        </p>
        <p className="mt-1.5 text-sm text-ink-muted">
          Everything on screen comes from those files and from the phased-execution scripts. The plans stay
          where they are — nothing is written unless the server was started with{' '}
          <code className="text-ink">--allow-writes</code>.
        </p>
      </header>

      {pinned && (
        <Banner severity="warn" className="mb-4">
          This console is pinned to <strong>{state?.instance?.name}</strong>
          {state?.root?.path ? (
            <>
              {' '}
              (<code>{state.root.path}</code>)
            </>
          ) : null}
          . To open a different project, run <code>phase-console start</code> in that project — it gets its
          own console, port and state.
        </Banner>
      )}

      {state?.recentRoots?.length ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Recent</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="grid gap-2 sm:grid-cols-2">
              {state.recentRoots.map((recent) => (
                <button
                  key={recent.path}
                  type="button"
                  disabled={open.isPending || pinned}
                  onClick={() => open.mutate(recent.path)}
                  className="min-h-(--tap-min) rounded border border-rule bg-surface px-3 py-2 text-left
                             hover:border-rule-strong hover:bg-surface-raised disabled:opacity-50"
                >
                  <span className="block truncate text-sm text-ink">{recent.label}</span>
                  <span className="block truncate font-mono text-2xs text-ink-faint">{recent.path}</span>
                </button>
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Browse</CardTitle>
          <div className="flex shrink-0 gap-2">
            {listing?.parent && (
              <Button size="sm" onClick={() => walkTo(listing.parent!)}>
                <ChevronUp className="size-3.5" aria-hidden /> Parent
              </Button>
            )}
            <Button size="sm" onClick={() => walkTo('~')}>
              <Home className="size-3.5" aria-hidden /> Home
            </Button>
          </div>
        </CardHeader>

        <CardBody>
          <label className="block">
            <span className="mb-1 block text-2xs tracking-wide text-ink-faint uppercase">Path</span>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canOpen) {
                  event.preventDefault();
                  open.mutate(path);
                }
              }}
              placeholder="/path/to/your-repo"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full min-w-0 rounded border border-rule bg-ground px-2 py-2 font-mono text-ink
                         placeholder:text-ink-faint focus:border-action focus:outline-none"
            />
          </label>
        </CardBody>

        <div className="max-h-72 overflow-y-auto border-y border-rule">
          {listingPending && !listing && (
            <div className="flex flex-col gap-1 p-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          )}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => walkTo(entry.path)}
              className="flex min-h-(--tap-min) w-full items-center gap-2 border-b border-rule/50 px-3 py-2
                         text-left last:border-b-0 hover:bg-surface-raised focus-visible:bg-surface-raised"
            >
              <Folder className="size-4 shrink-0 text-ink-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{entry.name}</span>
              {entry.hasDocs && <Chip tone="ok">plans</Chip>}
            </button>
          ))}
          {listing && !listing.entries.length && (
            <Empty title="Nothing to browse here" body="This directory has no sub-directories." />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            {check?.ok ? (
              <Banner severity="ok">
                <span className="font-mono">{check.planCount}</span> plans ·{' '}
                <span className="font-mono">{check.handoffCount}</span> handoff folders found in{' '}
                <code>{check.docsDir}</code>
              </Banner>
            ) : check ? (
              <Banner severity="warn">{check.reason ?? 'Not a source directory'}</Banner>
            ) : (
              <span className="text-sm text-ink-faint">
                Pick a directory that contains <code className="text-ink">docs/plans</code>.
              </span>
            )}
          </div>
          <Button variant="action" disabled={!canOpen} onClick={() => open.mutate(path)}>
            {open.isPending ? 'Opening…' : 'Open'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
