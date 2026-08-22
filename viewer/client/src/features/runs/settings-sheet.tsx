/**
 * The live settings sheet — every field a running run still accepts, behind
 * one button.
 *
 * ## Why a sheet and not the card it replaces
 *
 * The run page used to carry the whole settings form open, all the time, above
 * the thing you came to read. On a phone that is a screenful of controls
 * between the status line and the console, and the controls are the part you
 * touch once a run rather than once a minute. So the fields moved behind
 * `Settings`, and what stayed on the page is the status strip's verbs — the
 * ones that ARE pressed while watching.
 *
 * Bottom sheet on purpose (`side="bottom"`): it opens under the thumb, and the
 * form inside it is tall. `SheetContent` traps focus and restores it on close,
 * which the old inline card could not do because it was never dismissed.
 *
 * ## The mode is the contract
 *
 * `RunSetup` mode `live` is a settings PATCH, not a launch. It shows only the
 * fields `/api/run/:slug/settings` accepts — no `resumeRunId`, no `qa`, no
 * `accountId` (that one is its own verb, because moving a live run's account is
 * a different act from editing its budget) — and `modes.ts` `buildRunPayload`
 * reads only the fields the mode shows, so a value seeded but not rendered
 * cannot leak into the body. Phase 6 pins both the field set and the payload.
 *
 * Everything it changes reaches the NEXT phase to board. The session already
 * running had its model and budget fixed in its own command line, and there is
 * no honest way to change those underneath it — so the sheet says so rather
 * than letting the operator infer it from a value that did not take.
 */

import { useState, type ReactNode } from 'react';
import { Button, Sheet, SheetContent, SheetTrigger } from '@/components/ui';
import type { PhaseView, RunState } from '@/lib/api';
import { RunSetup } from '@/features/run-setup/run-setup';

export function SettingsSheet({
  slug,
  run,
  live,
  allowRun,
  planPhases,
  planSkills,
  planMcp = [],
  qaMode,
  allowWrites,
  trigger,
}: {
  slug: string;
  run: RunState | null;
  /** A live run patches (`live`); a stopped one is continued (`continue`); none is started. */
  live: boolean;
  allowRun: boolean;
  planPhases: PhaseView[];
  planSkills: string[];
  planMcp?: string[];
  qaMode?: string;
  allowWrites?: boolean;
  /** The control that opens it. Defaults to a plain `Settings` button. */
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const resumable = Boolean(run) && !live && run?.status !== 'finished';
  const mode = live ? 'live' : resumable ? 'continue' : 'start';

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="ghost">
            Settings
          </Button>
        )}
      </SheetTrigger>
      <SheetContent
        side="bottom"
        showTitle
        title={live ? 'Run settings' : resumable ? 'Continue this run' : 'Start a run'}
        description={
          live
            ? 'Applies from the next phase to board. The session running now was started with its model and budget fixed in its own command line.'
            : resumable
              ? 'Picks up from the board, not from a saved position.'
              : 'Fresh or half finished is the same button — the done-set decides where it begins.'
        }
        className="max-h-[85dvh] overflow-y-auto"
      >
        <RunSetup
          mode={mode}
          context={{ slug, run }}
          planPhases={planPhases}
          planSkills={planSkills}
          planMcp={planMcp}
          {...(qaMode !== undefined ? { qaMode } : {})}
          {...(allowWrites !== undefined ? { allowWrites } : {})}
          blocked={!allowRun}
          {...(allowRun ? {} : { blockedReason: 'Controls need --allow-run.' })}
          // Closing on success is the point of a sheet: the form said what it
          // did with a toast, and leaving it open invites a second submit of
          // the same patch.
          onDone={() => setOpen(false)}
          cancel={
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          }
        />
      </SheetContent>
    </Sheet>
  );
}

export default SettingsSheet;
