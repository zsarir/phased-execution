/**
 * The guarded write verbs.
 *
 * Every action shows **the exact script invocation before it runs**, and the
 * server refuses all of them unless it was started with `--allow-writes`. The
 * console never commits or pushes — `--git` is not available to it, and
 * `runWrite` throws if an argument list contains it.
 *
 * Ported from `web/components/writes.js`. Two things changed:
 *
 * 1. **The preview is a query, not an effect.** The old dialog re-ran
 *    `api.write(payload, true)` from a `useEffect` keyed on
 *    `JSON.stringify(payload)` — a fresh request per keystroke, with no
 *    cancellation, so a slow one could land after a faster later one and show a
 *    command for input that had already changed. It is a debounced mutation
 *    against a single state now, so what is on screen is always the answer to
 *    what is in the form.
 * 2. **The scaffolding of a handoff invalidates the plan.** The old one called
 *    `clearCache()` — a whole-cache drop, which is also what made every open
 *    view refetch at once.
 *
 * ⚠️ This is a **live feature on this console** (it runs with writes enabled),
 * and Phase 8 deletes `web/`. It is ported rather than dropped for that reason.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type PlanDetail, type PhaseView, type WriteRequest, type WriteResult } from '@/lib/api';
import { keys } from '@/lib/queries';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  toast,
} from '@/components/ui';
import { isClosed } from '@/lib/closure';
import { ReleaseStaleButton } from '@/components/release-lock';

const OWNER_KEY = 'phase-console.owner';

/** How long to sit still before asking the server to render the command. */
const PREVIEW_DEBOUNCE_MS = 150;

interface Field {
  name: string;
  label: string;
  type?: 'text' | 'select' | 'checkbox';
  options?: readonly string[];
  placeholder?: string;
  required?: boolean;
  /** Remembered in localStorage under this key once the action succeeds. */
  remember?: string;
}

interface Form {
  title: string;
  hint: string;
  fields: readonly Field[];
}

export const FORMS: Record<string, Form> = {
  'new-handoff': {
    title: 'Scaffold a handoff',
    hint: 'Runs new-handoff.sh, which also creates or updates INDEX.md and generates the boot prompts for whatever this phase unblocks.',
    fields: [
      { name: 'title', label: 'Title (kebab-case)', placeholder: 'cart-api-endpoint', required: true },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        options: ['complete', 'in-progress', 'blocked', 'pending'],
      },
      { name: 'qa', label: 'Turn QA on for this plan (--qa)', type: 'checkbox' },
      { name: 'force', label: 'Overwrite an existing handoff (--force)', type: 'checkbox' },
    ],
  },
  'qa-record': {
    title: 'Record a QA result',
    hint: 'Writes one row into test-status.md. A recorded fail holds every dependent until it is re-run.',
    fields: [
      { name: 'result', label: 'Result', type: 'select', options: ['pass', 'fail', 'waived', 'pending'] },
      {
        name: 'report',
        label: 'Report path (relative)',
        placeholder: 'reports/phase-08-qa.md',
        required: true,
      },
    ],
  },
  'lock-claim': {
    title: 'Claim the phase',
    hint: 'Cooperative lock so two sessions never build the same phase. Written locally only — it is not committed or pushed from here.',
    fields: [
      {
        name: 'owner',
        label: 'Owner (account/session)',
        placeholder: 'you@example.com/session-name',
        required: true,
        remember: OWNER_KEY,
      },
      { name: 'force', label: 'Take over a live lock (--force)', type: 'checkbox' },
    ],
  },
  'lock-release': {
    title: 'Release the phase',
    hint: 'Clears the lock file. Use this when a session ended without releasing.',
    fields: [
      {
        name: 'owner',
        label: 'Owner (account/session)',
        placeholder: 'you@example.com/session-name',
        required: true,
        remember: OWNER_KEY,
      },
    ],
  },
  'new-plan': {
    title: 'Scaffold a plan',
    hint: 'Runs new-plan.sh to create docs/plans/<slug>.md from the template. Fill in the phases yourself — that part is thinking, not scaffolding.',
    fields: [
      { name: 'slug', label: 'Slug (kebab-case)', placeholder: 'customer-tool-requests', required: true },
    ],
  },
  // A form rather than a bare confirm, because closing takes two decisions: WHICH
  // terminal word (they mean different things to the next reader) and WHY. The
  // server rejects a reasonless close, so the reason field is required here too —
  // caught before the round trip, where the message can be about the field.
  // `active` is deliberately absent: reopening is its own verb, not a status.
  'close-plan': {
    title: 'Close this plan',
    hint: 'Runs close-plan.sh. The plan stops reporting ready work, warnings and prompts — its board stays visible in full. Reversible: Reopen puts it back to active.',
    fields: [
      { name: 'status', label: 'Close as', type: 'select', options: ['abandoned', 'superseded', 'complete'] },
      {
        name: 'reason',
        label: 'Why (one line)',
        placeholder: 'superseded by console-operability',
        required: true,
      },
    ],
  },
};

type Values = Record<string, string | boolean>;

function initialValues(form: Form): Values {
  const out: Values = {};
  for (const field of form.fields) {
    if (field.type === 'checkbox') out[field.name] = false;
    else if (field.type === 'select') out[field.name] = field.options?.[0] ?? '';
    else out[field.name] = field.remember ? (localStorage.getItem(field.remember) ?? '') : '';
  }
  return out;
}

function WriteDialog({
  action,
  base,
  onClose,
  onDone,
}: {
  action: string;
  base: Partial<WriteRequest>;
  onClose: () => void;
  onDone?: () => void;
}) {
  const form = FORMS[action];
  const [values, setValues] = useState<Values>(() => initialValues(form));
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WriteResult | null>(null);
  const client = useQueryClient();

  const payload: WriteRequest = { action, ...base, ...values };
  const key = JSON.stringify(payload);

  // A dry run per settled edit, not per keystroke. `live` is the cancellation
  // the old effect did not have: without it a slow preview can land after a
  // faster later one and show the command for input that has changed.
  useEffect(() => {
    let live = true;
    const id = setTimeout(() => {
      api
        .write(JSON.parse(key) as WriteRequest, true)
        .then((result) => {
          if (live) {
            setPreview(result.command ?? null);
            setError(null);
          }
        })
        .catch((failure: Error) => {
          if (live) {
            setPreview(null);
            setError(String(failure.message ?? failure));
          }
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [key]);

  const run = useMutation({
    mutationFn: () => api.write(payload),
    onSuccess: (result) => {
      setOutcome(result);
      for (const field of form.fields) {
        const value = values[field.name];
        if (field.remember && typeof value === 'string' && value) {
          try {
            localStorage.setItem(field.remember, value);
          } catch {
            /* private mode */
          }
        }
      }
      // Only what this could have changed, rather than the whole cache: a
      // handoff moves the board, which is `plans` plus this plan's prefix.
      void client.invalidateQueries({ queryKey: keys.plans() });
      void client.invalidateQueries({ queryKey: keys.stats() });
      if (typeof base.slug === 'string') {
        void client.invalidateQueries({ queryKey: keys.plan(base.slug) });
      }
      toast(result.ok ? 'Done' : 'The script reported a problem', result.ok ? 'ok' : 'error');
      onDone?.();
    },
    onError: (failure: Error) => setError(String(failure.message ?? failure)),
  });

  const missing = form.fields.some((f) => f.required && !String(values[f.name] ?? '').trim());

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent title={form.title} description={form.hint}>
        <div className="flex flex-col gap-3">
          {form.fields.map((field) => (
            <label key={field.name} className="flex flex-wrap items-center gap-2">
              <span className="min-w-44 font-display text-2xs tracking-[0.12em] text-ink-faint uppercase">
                {field.label}
              </span>
              {field.type === 'checkbox' ? (
                <input
                  type="checkbox"
                  className="accent-[var(--action)]"
                  checked={Boolean(values[field.name])}
                  onChange={(event) => setValues({ ...values, [field.name]: event.target.checked })}
                />
              ) : field.type === 'select' ? (
                <select
                  value={String(values[field.name] ?? '')}
                  onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                  className="min-h-(--tap-min) min-w-0 flex-1 rounded border border-rule bg-ground px-2 text-sm text-ink"
                >
                  {field.options?.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={String(values[field.name] ?? '')}
                  placeholder={field.placeholder}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                  className="min-h-(--tap-min) min-w-0 flex-1 rounded border border-rule bg-ground px-2 font-mono text-sm text-ink placeholder:text-ink-faint"
                />
              )}
            </label>
          ))}

          {error && <Banner severity="error">{error}</Banner>}

          {preview && (
            <div>
              <h4 className="mb-1 font-display text-2xs tracking-[0.14em] text-ink-faint uppercase">
                Will run
              </h4>
              <pre className="overflow-x-auto rounded border border-rule bg-ground p-2 font-mono text-2xs whitespace-pre-wrap text-ink">
                {preview}
              </pre>
            </div>
          )}

          {outcome && (
            <div className="flex flex-col gap-2">
              <Banner severity={outcome.ok ? 'ok' : 'error'}>
                {outcome.ok ? 'Completed' : `Exit code ${outcome.code}`}
              </Banner>
              {outcome.stdout && (
                <pre className="max-h-48 overflow-auto rounded border border-rule bg-ground p-2 font-mono text-2xs whitespace-pre-wrap text-ink-muted">
                  {outcome.stdout}
                </pre>
              )}
              {outcome.stderr && (
                <pre className="max-h-48 overflow-auto rounded border border-rule bg-ground p-2 font-mono text-2xs whitespace-pre-wrap text-blocked">
                  {outcome.stderr}
                </pre>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="items-center justify-between">
          <span className="text-2xs text-ink-faint">Nothing is committed or pushed.</span>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button variant="ghost">{outcome ? 'Close' : 'Cancel'}</Button>
            </DialogClose>
            {!outcome && (
              <Button
                variant="action"
                disabled={!preview || missing || run.isPending}
                onClick={() => run.mutate()}
              >
                {run.isPending ? 'Running…' : 'Run'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The write actions for a plan, or for one phase of it.
 *
 * `allowWrites` is passed rather than read here so a caller cannot forget it:
 * both call sites take it from `/api/state`, and a menu that decided for itself
 * would be one place for that check to drift.
 */
export function WriteMenu({
  detail,
  phase,
  allowWrites,
  inline = false,
  onChanged,
}: {
  detail: PlanDetail;
  phase?: PhaseView;
  allowWrites: boolean;
  /** Render inside a card of its own — the phase panel's sidebar. */
  inline?: boolean;
  onChanged?: () => void;
}) {
  const [action, setAction] = useState<string | null>(null);
  const slug = detail.summary.slug;
  const base: Partial<WriteRequest> = phase ? { slug, phase: phase.phase } : { slug };

  const openEditor = async (path: string) => {
    try {
      await api.write({ action: 'open-editor', path });
      toast('Handed to your editor');
    } catch (failure) {
      toast(String((failure as Error).message ?? failure), 'error');
    }
  };

  if (!allowWrites) {
    // The rail already says the session is read-only; repeating it in every
    // header is noise. The phase panel's sidebar is the one place worth saying
    // what turning it on would give you.
    if (!inline) return null;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardBody className="text-sm text-ink-faint">
          Writes are off. Restart with <code>--allow-writes</code> to scaffold handoffs, record QA results and
          manage phase locks from here.
        </CardBody>
      </Card>
    );
  }

  // The plan-level list was empty until closure gave it something to do. Only
  // one of Close / Reopen is ever offered, because they are the two directions
  // of one switch and showing both would make you read the plan's status off
  // some other part of the page to know which one applies.
  const closed = isClosed(detail.summary);
  const actions: [string, string][] = phase
    ? [
        ['new-handoff', 'Scaffold handoff'],
        ['qa-record', 'Record QA'],
        phase.lock && !phase.lock.expired ? ['lock-release', 'Release lock'] : ['lock-claim', 'Claim phase'],
      ]
    : closed
      ? []
      : [['close-plan', 'Close plan']];

  const buttons = (
    <div className="flex flex-wrap gap-2">
      {actions.map(([id, label]) => (
        <Button key={id} size="sm" onClick={() => setAction(id)}>
          {label}
        </Button>
      ))}
      {/* Reopen takes no input, so it gets a confirm rather than a form — but a
          confirm and not a bare button, because it silently puts the plan's
          phases back on the ready board and into every count on the console.
          Not `destructive`: it restores, and red would say the opposite. */}
      {!phase && closed && <ReopenPlanButton slug={slug} onDone={onChanged} />}
      {/* An expired lock used to offer only "Claim phase", which takes the
          phase rather than freeing it — so the one action that fixed a stale
          claim was the one the menu did not have. Both are offered now, and
          this one needs no owner typed: the server reads it from the file. */}
      {phase?.lock?.expired && <ReleaseStaleButton slug={slug} phase={phase.phase} onDone={onChanged} />}
      {!phase && detail.plan?.path && (
        <Button size="sm" onClick={() => void openEditor(detail.plan!.path!)}>
          Open in editor
        </Button>
      )}
    </div>
  );

  return (
    <>
      {inline ? (
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardBody>{buttons}</CardBody>
        </Card>
      ) : (
        buttons
      )}
      {action && (
        <WriteDialog action={action} base={base} onClose={() => setAction(null)} onDone={onChanged} />
      )}
    </>
  );
}

/**
 * Reopen a closed plan — the one write on this console that takes no argument.
 *
 * It runs `close-plan.sh <slug> --reopen`, which sets the status back to
 * `active` and clears `closed:` / `closed_reason:`. Confirmed rather than
 * immediate: from the operator's side it is one small button, and from the
 * console's side it is a plan reappearing on the ready board, in the nav badge,
 * in the dashboard's recommendation and in the notification stream all at once.
 *
 * Invalidates exactly what closure feeds: the plan list, the portfolio, and this
 * plan's own prefix — the same three keys `WriteDialog` settles on.
 */
function ReopenPlanButton({ slug, onDone }: { slug: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();

  const run = useMutation({
    mutationFn: () => api.write({ action: 'reopen-plan', slug }),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: keys.plans() });
      void client.invalidateQueries({ queryKey: keys.stats() });
      void client.invalidateQueries({ queryKey: keys.plan(slug) });
      toast(
        result.ok ? 'Reopened — the plan is active again' : 'The script reported a problem',
        result.ok ? 'ok' : 'error',
      );
      onDone?.();
    },
    onError: (failure: Error) => toast(String(failure.message ?? failure), 'error'),
  });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" disabled={run.isPending}>
          {run.isPending ? 'Reopening…' : 'Reopen plan'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        title="Reopen this plan?"
        description={`Sets ${slug} back to active and clears its closed reason. Its ready phases go back on the departures board, into the nav count and into the dashboard's recommendation, and it starts raising warnings again.`}
        confirmLabel="Reopen"
        onConfirm={() => run.mutate()}
      />
    </AlertDialog>
  );
}

/** Standalone "new plan" button for the plans list. */
export function NewPlanButton({ allowWrites }: { allowWrites: boolean }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  if (!allowWrites) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        New plan
      </Button>
      {open && (
        <WriteDialog
          action="new-plan"
          base={{}}
          onClose={() => setOpen(false)}
          onDone={() => void client.invalidateQueries({ queryKey: keys.plans() })}
        />
      )}
    </>
  );
}
