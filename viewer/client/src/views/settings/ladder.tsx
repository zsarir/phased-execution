/**
 * The ladder's knobs — what the autopilot may do by itself, and how much of it.
 *
 * Twelve server-side preferences, all per console (`~/.config/phase-console/…`
 * per instance), all already honoured by the runner and the convergence loop
 * before this card existed: the ladder caps (rungs AND dollars per phase, per
 * run, per day), how often the loop sweeps, the one budget raise, how long a
 * `require` MCP park waits, and the four toggles the design named — unblock
 * attempts on a declared blocker, taking over a stale foreign claim, resuming
 * the lanes a console restart killed, switching to an account that can pay.
 * QA auto-dispatch is deliberately not here: the autopilot never spawns
 * reviewers on its own, and a knob that does not exist cannot be turned on.
 *
 * Same discipline as the Automation card beside it: rendered from `/api/state`
 * (what the process holds, never a local copy of the intention), saved one key
 * per change through `POST /api/prefs`, which merges server-side — two tabs
 * editing different knobs must not overwrite each other. A number field saves
 * on blur or Enter; the server's sanitiser keeps finite numbers ≥ 0 and falls
 * back to the default for anything else, so a cleared field reads as the
 * shipped value on the next render rather than as zero.
 */

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, useConsoleState } from '@/lib/queries';
import { api, ladderPrefs, LADDER_PREF_DEFAULTS } from '@/lib/api';
import { STALL_DEFAULTS } from '@shared/attention-model.js';
import { Button, Card, CardBody, CardHeader, CardTitle, Skeleton, toast } from '@/components/ui';

/** Minutes ⇄ milliseconds for the two interval knobs; 0 stays 0 ("off" / "forever"). */
const minutes = (ms: number) => (ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0);

/**
 * One numeric knob: local text while typing, the preference on blur/Enter.
 * `unit` is shown after the field; `zero` is what the field means at 0.
 */
function NumberField({
  id,
  label,
  hint,
  value,
  unit,
  zero,
  min = 0,
  step = 1,
  disabled,
  onSave,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  unit?: string;
  /** The sentence for a zero — e.g. "0 = never". Omit when zero is just zero. */
  zero?: string;
  min?: number;
  step?: number;
  disabled?: boolean;
  onSave: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // The process is the truth: when a save lands (or another tab's does), the
  // field follows what the server now holds.
  useEffect(() => {
    setText(String(value));
  }, [value]);
  const commit = () => {
    const next = Number(text);
    if (!Number.isFinite(next) || next < min) {
      setText(String(value));
      return;
    }
    if (next === value) return;
    onSave(next);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      (event.target as HTMLInputElement).blur();
    }
    if (event.key === 'Escape') {
      setText(String(value));
      (event.target as HTMLInputElement).blur();
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="min-w-0">
        <label htmlFor={id} className="text-sm text-ink">
          {label}
        </label>
        <span className="mt-0.5 block text-2xs text-ink-muted">
          {hint}
          {zero ? ` ${zero}` : ''}
        </span>
      </span>
      <span className="inline-flex items-center gap-1">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          className="min-h-(--tap-min) w-24 rounded border border-rule bg-ground px-2 text-right font-mono text-sm tabular-nums text-ink"
        />
        {unit && <span className="text-2xs text-ink-muted">{unit}</span>}
      </span>
    </div>
  );
}

export function LadderCard() {
  const client = useQueryClient();
  const { data: state, isPending } = useConsoleState();

  const save = useMutation({
    // One key at a time, merged server-side — see the Automation card.
    mutationFn: (patch: Record<string, unknown>) => api.savePrefs(patch),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.state() });
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (isPending && !state) return <Skeleton className="h-64" />;

  const prefs = ladderPrefs(state);
  // Same `?? shipped` rule as `ladderPrefs`, for the three keys the stall
  // detector reads. A console whose config predates them reads the defaults
  // rather than zero, which would mean "never notice".
  const stored = state?.prefs ?? {};
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const stall = {
    stallSilentMs: positive(stored.stallSilentMs, STALL_DEFAULTS.stallSilentMs),
    stallSpinTurns: positive(stored.stallSpinTurns, STALL_DEFAULTS.stallSpinTurns),
    stallStalemateAttempts: positive(stored.stallStalemateAttempts, STALL_DEFAULTS.stallStalemateAttempts),
  };
  const busy = save.isPending;
  const row = 'flex flex-wrap items-center justify-between gap-2';
  const onOff = (value: boolean, key: string) => (
    <Button size="sm" aria-pressed={value} disabled={busy} onClick={() => save.mutate({ [key]: !value })}>
      {value ? 'On' : 'Off'}
    </Button>
  );
  const num = (key: string) => (value: number) => save.mutate({ [key]: value });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation · the ladder</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-2xs text-ink-muted">
          A stopped phase is classified (never started, work in progress, done but unrecorded, verification
          red, declared blocked, a resource wall…) and the autopilot climbs that situation&apos;s ladder — its
          own session first, a fresh briefed session next — until a rung holds or these caps are spent. Then
          it leaves ONE errand and drives everything else.
        </p>

        <h3 className="text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">
          Caps — rungs and dollars
        </h3>
        <NumberField
          id="ladder-per-phase-rungs"
          label="Rungs per phase"
          value={prefs.ladderPerPhaseRungs}
          unit="rungs"
          hint={`How many rungs one phase may climb before its errand is written (shipped: ${LADDER_PREF_DEFAULTS.ladderPerPhaseRungs}).`}
          disabled={busy}
          onSave={num('ladderPerPhaseRungs')}
        />
        <NumberField
          id="ladder-per-phase-usd"
          label="Spend per phase"
          value={prefs.ladderPerPhaseUsd}
          unit="USD"
          step={10}
          hint={`What the ladder may spend on one phase, every rung counted (shipped: $${LADDER_PREF_DEFAULTS.ladderPerPhaseUsd}).`}
          disabled={busy}
          onSave={num('ladderPerPhaseUsd')}
        />
        <NumberField
          id="ladder-per-run-rungs"
          label="Rungs per run"
          value={prefs.ladderPerRunRungs}
          unit="rungs"
          hint={`Across every phase of one run (shipped: ${LADDER_PREF_DEFAULTS.ladderPerRunRungs}).`}
          disabled={busy}
          onSave={num('ladderPerRunRungs')}
        />
        <NumberField
          id="ladder-per-run-usd"
          label="Spend per run"
          value={prefs.ladderPerRunUsd}
          unit="USD"
          step={10}
          hint={`Across every phase of one run (shipped: $${LADDER_PREF_DEFAULTS.ladderPerRunUsd}). The one automatic budget raise stays inside this.`}
          disabled={busy}
          onSave={num('ladderPerRunUsd')}
        />
        <NumberField
          id="ladder-per-day-usd"
          label="Spend per day"
          value={prefs.ladderPerDayUsd}
          unit="USD"
          step={10}
          hint={`Across every run this console drives in a day (shipped: $${LADDER_PREF_DEFAULTS.ladderPerDayUsd}).`}
          disabled={busy}
          onSave={num('ladderPerDayUsd')}
        />

        <h3 className="mt-1 text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">Clocks</h3>
        <NumberField
          id="ladder-converge-every"
          label="Sweep every"
          value={minutes(prefs.convergeEveryMs)}
          unit="min"
          hint="How often the convergence loop re-reads every open plan even when nothing happened. Boot, a docs change and the minute after a stop always run a pass."
          zero="0 turns the timer off (the other triggers stay)."
          disabled={busy}
          onSave={(v) => save.mutate({ convergeEveryMs: v * 60_000 })}
        />
        <NumberField
          id="ladder-mcp-require-timeout"
          label="Park on a required MCP server for"
          value={minutes(prefs.mcpRequireTimeoutMs)}
          unit="min"
          hint={`A phase parked by the require policy continues without the server after this long, an errand recorded (shipped: ${minutes(LADDER_PREF_DEFAULTS.mcpRequireTimeoutMs)} min).`}
          zero="0 waits for the server to heal, however long."
          disabled={busy}
          onSave={(v) => save.mutate({ mcpRequireTimeoutMs: v * 60_000 })}
        />
        <NumberField
          id="ladder-budget-raise"
          label="Raise a spent run budget once by"
          value={prefs.budgetAutoRaisePct}
          unit="%"
          hint={`The resource ladder's one budget raise, within the per-run cap above (shipped: ${LADDER_PREF_DEFAULTS.budgetAutoRaisePct}%).`}
          zero="0 never raises — a spent budget halts with an errand at once."
          disabled={busy}
          onSave={num('budgetAutoRaisePct')}
        />

        {/* Phase 5 gave the console a way to notice a lane that has stopped
            being work. These are its three thresholds — and they are
            thresholds, not policy: crossing one announces and journals it, and
            what happens next is still a person's press. */}
        <h3 className="mt-1 text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">
          When a lane stops being work
        </h3>
        <NumberField
          id="stall-silent"
          label="Call a lane silent after"
          value={minutes(stall.stallSilentMs)}
          unit="min"
          hint={`No output at all for this long, suppressed while a phase is verifying (shipped: ${minutes(STALL_DEFAULTS.stallSilentMs)} min).`}
          zero="0 never calls a lane silent."
          disabled={busy}
          onSave={(v) => save.mutate({ stallSilentMs: v * 60_000 })}
        />
        <NumberField
          id="stall-spin"
          label="Call it spinning after"
          value={stall.stallSpinTurns}
          unit="turns"
          hint={`Consecutive assistant turns with no tool call in any of them — thinking, not doing (shipped: ${STALL_DEFAULTS.stallSpinTurns}).`}
          zero="0 never calls a lane spinning."
          disabled={busy}
          onSave={num('stallSpinTurns')}
        />
        <NumberField
          id="stall-stalemate"
          label="Call it a stalemate after"
          value={stall.stallStalemateAttempts}
          unit="attempts"
          hint={`Attempts in a row that committed nothing and left a clean tree — re-running has stopped being a remedy (shipped: ${STALL_DEFAULTS.stallStalemateAttempts}).`}
          zero="0 never calls a stalemate."
          disabled={busy}
          onSave={num('stallStalemateAttempts')}
        />

        <h3 className="mt-1 text-2xs font-medium uppercase tracking-[0.14em] text-ink-faint">
          What it may do by itself
        </h3>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Unblock attempts</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A handoff marked blocked for a reason no machine category fits gets ONE bounded session
              explicitly allowed to do the unblocking work — then an errand. Off: the errand at once.
            </span>
          </span>
          {onOff(prefs.unblockAttempts, 'unblockAttempts')}
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Take over stale claims</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              An expired foreign lock over unfinished work is taken over and the work continued. A LIVE
              session&apos;s claim is never touched, whatever this says.
            </span>
          </span>
          {onOff(prefs.staleClaimTakeover, 'staleClaimTakeover')}
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Resume killed lanes at boot</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A lane a console restart killed resumes its own session when the console is back — at most 3
              restarts in a row per phase, then an errand.
            </span>
          </span>
          {onOff(prefs.resumeAtBoot, 'resumeAtBoot')}
        </div>
        <div className={row}>
          <span className="min-w-0">
            <span className="text-sm text-ink">Switch accounts at a wall</span>
            <span className="mt-0.5 block text-2xs text-ink-muted">
              A signed-out run account, or a usage window too far out to sleep on, switches to a registered
              account that can pay — the session&apos;s transcript comes along. Off: the wall halts with an
              errand.
            </span>
          </span>
          {onOff(prefs.autoAccountSwitch, 'autoAccountSwitch')}
        </div>

        <p className="text-2xs text-ink-muted">
          Every automatic act is journalled on the run (<code>phase.situation</code>, <code>phase.rung</code>,{' '}
          <code>phase.errand</code>, <code>run.converge</code>) and yields to your Stop. QA is never
          dispatched by itself — that stays a press. The session-presence hook beside this card is what lets
          the loop see the sessions it shares the repository with.
        </p>
      </CardBody>
    </Card>
  );
}
