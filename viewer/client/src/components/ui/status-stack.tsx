import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * One place for "the app needs to tell you something about this screen".
 *
 * The old run view grew nine of these independently — a stale-server banner, a
 * paused banner, a frozen banner, an approval banner, a verification banner and
 * so on — each rendered wherever it was written, so two could stack in either
 * order, three could push the actual content below the fold, and none of them
 * knew the others existed. `StatusStack` owns the slot: notes go in with a
 * severity, it orders them worst-first and renders at most `max`.
 *
 * Phase 4 fills this with the run's real states; here it is the primitive plus
 * the ordering rule.
 */

export const noteVariants = cva(
  'flex items-start gap-2 rounded border px-3 py-2 text-sm',
  {
    variants: {
      severity: {
        error: 'border-blocked/55 bg-blocked/8 text-blocked',
        warn: 'border-action/55 bg-action/8 text-ink',
        info: 'border-progress/45 bg-progress/8 text-ink',
        ok: 'border-done/45 bg-done/8 text-ink',
      },
    },
    defaultVariants: { severity: 'info' },
  },
);

export type Severity = NonNullable<VariantProps<typeof noteVariants>['severity']>;

/** Worst first — an error must never sort below a hint. */
const ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2, ok: 3 };

/**
 * How a caller's notes get ordered.
 *
 * `severity` is the default and the right rule when the notes are unrelated —
 * it is the only ordering available from the notes themselves. `given` is for a
 * caller that has a *declared* priority the severities do not encode: the run
 * view orders by how much a note needs a person (approval, then halt, then a
 * pause, down to standing configuration facts), and severity is a consequence of
 * that judgement rather than a substitute for it. Sorting such a list by
 * severity would put "you are on bypass" above "the run finished", which is
 * backwards.
 */
export type NoteOrder = 'severity' | 'given';

export interface StatusNote {
  id: string;
  severity: Severity;
  title?: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}

export function Banner({
  severity,
  className,
  children,
  ...props
}: { severity?: Severity } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="status" className={cn(noteVariants({ severity }), className)} {...props}>
      {children}
    </div>
  );
}

export function StatusStack({
  notes,
  max = 3,
  order = 'severity',
  className,
}: {
  notes: readonly StatusNote[];
  /** Beyond this the stack is the problem. The rest are counted, not shown. */
  max?: number;
  order?: NoteOrder;
  className?: string;
}) {
  if (!notes.length) return null;
  const sorted = order === 'given'
    ? notes
    : [...notes].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const shown = sorted.slice(0, max);
  const hidden = sorted.length - shown.length;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {shown.map((note) => (
        <Banner key={note.id} severity={note.severity}>
          <div className="min-w-0 flex-1">
            {note.title != null && <strong className="font-semibold">{note.title}</strong>}
            {note.title != null && note.body != null && ' '}
            {note.body}
          </div>
          {note.action != null && <div className="shrink-0">{note.action}</div>}
        </Banner>
      ))}
      {hidden > 0 && (
        <p className="text-2xs text-ink-faint">
          and {hidden} more {hidden === 1 ? 'note' : 'notes'}
        </p>
      )}
    </div>
  );
}
