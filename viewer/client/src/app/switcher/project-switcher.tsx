import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronsUpDown, FolderOpen } from 'lucide-react';
import { api, type ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from '@/components/ui';
import { useNavigate } from '@/app/router';

/**
 * Which project this console is looking at — and the way to another one.
 *
 * The 2.x rail spent a whole card on this: a two-line button, a census, and a
 * "Change" affordance that took you to the full directory picker every time,
 * even to go back to the repository you were in ten minutes ago. Almost every
 * switch is a return to somewhere recent, so the recents are the menu and the
 * picker is its last item.
 *
 * A **pinned** console serves one project and answers 409 to any other. The
 * menu still opens — hiding it leaves someone staring at a name they cannot act
 * on — but the recents are inert and the reason is on screen, because
 * discovering a refusal by pressing a button and reading a toast is strictly
 * worse.
 */
export function ProjectSwitcher({
  state,
  counts,
  phone,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  phone: boolean;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const pinned = state?.instance?.pinned === true;
  const here = state?.root?.path;

  const openRoot = useMutation({
    mutationFn: (target: string) => api.openRoot(target),
    onSuccess: async (result) => {
      if (!result.check?.ok) {
        toast(result.check?.reason ?? 'Could not open that directory', 'error');
        return;
      }
      // Everything on screen was about the old repository.
      await client.invalidateQueries();
      toast(`Opened ${result.check.label}`);
      navigate('now');
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const recents = (state?.recentRoots ?? []).filter((recent) => recent.path !== here);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Project: ${state?.root?.label ?? 'none open'}. Choose another.`}
          title={state?.root?.path ?? 'no source open'}
          className="flex min-h-(--tap-min) min-w-0 shrink items-center gap-1.5 rounded px-2 text-left text-sm text-ink-muted hover:text-ink md:min-h-0 md:py-1"
        >
          <span className="min-w-0 truncate">{state?.root?.label ?? 'Choose a directory'}</span>
          {!phone && (
            <span className="shrink-0 text-2xs text-ink-faint tnum">
              {counts.plans} plans · {counts.phases} phases
            </span>
          )}
          <ChevronsUpDown size={13} className="shrink-0 text-ink-faint" aria-hidden />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-72">
        <DropdownMenuLabel>Open here</DropdownMenuLabel>
        <DropdownMenuItem disabled className="opacity-100">
          <Check size={14} className="shrink-0 text-status-done" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate">{state?.root?.label ?? 'no source open'}</span>
            <span className="block truncate font-mono text-2xs text-ink-faint">
              {state?.root?.path ?? '—'}
            </span>
          </span>
        </DropdownMenuItem>

        {pinned ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-2xs text-ink-faint">
              This console is pinned to one project. To open another, run{' '}
              <code className="font-mono">phase-console start</code> in it — it gets its own console, port and
              state.
            </div>
          </>
        ) : (
          <>
            {recents.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Recent</DropdownMenuLabel>
                {recents.map((recent) => (
                  <DropdownMenuItem
                    key={recent.path}
                    disabled={openRoot.isPending}
                    onSelect={() => openRoot.mutate(recent.path)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{recent.label}</span>
                      <span className="block truncate font-mono text-2xs text-ink-faint">{recent.path}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('source')}>
              <FolderOpen size={14} className="shrink-0" aria-hidden />
              Browse for a directory…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The picker, for a shell that has to offer it without a menu (the empty state). */
export function PickSourceButton() {
  const navigate = useNavigate();
  return (
    <Button size="sm" onClick={() => navigate('source')}>
      Choose a directory
    </Button>
  );
}
