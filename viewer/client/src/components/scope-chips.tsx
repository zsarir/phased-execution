import { Chip } from '@/components/ui';

/** Scope chips shown before the row starts eliding. The rest go in the title. */
const SCOPE_SHOWN = 2;

/**
 * The repos a phase touches, as chips — the fact that decides what may run
 * beside it, and what a queued phase overlaps. A blank cell is `all`, which is
 * the honest rendering of "this might touch anything": it is why the phase
 * runs alone, and it used to be invisible.
 *
 * Elided rather than wrapped: a plan with five repos per phase turns any
 * column of these into the widest one on the page, and the full list is a
 * hover away.
 *
 * Shared by the run phases table and the plan's phases tab — one component so
 * the two surfaces cannot drift on what a scope looks like.
 */
export function ScopeChips({
  tokens,
  conflicts,
}: {
  tokens: string[];
  conflicts?: string[] | undefined;
}) {
  const shown = tokens.slice(0, SCOPE_SHOWN);
  const hidden = tokens.length - shown.length;
  const title = tokens.join(', ')
    + (conflicts?.length ? `\n\nwould collide with: ${conflicts.join(', ')}` : '');

  return (
    <div className="flex flex-wrap items-center gap-1" title={title}>
      {shown.map((token) => (
        <Chip key={token} mono tone={token === 'all' ? 'warn' : undefined}>
          {token}
        </Chip>
      ))}
      {hidden > 0 && <span className="font-mono text-2xs text-ink-faint">+{hidden}</span>}
    </div>
  );
}
