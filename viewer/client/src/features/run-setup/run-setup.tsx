/**
 * One form for every way of starting or configuring work.
 *
 * Before this there were four: a launch dialog, the run page's controls card,
 * the agent launcher and the Automation settings card. They offered
 * overlapping subsets of the same choices under different words, seeded from
 * different places, and sent different payloads — so "Continue" on a plan page
 * could not set a budget while "Continue" on the run page could, "Permissions"
 * meant a run profile in one and a CLI mode in another, and a preference the
 * operator had set in Settings reached three of the four.
 *
 * `RunSetup` is the one component. A **mode** is a field set plus a payload
 * builder (`modes.ts`), the value shape is one object (`schema.ts`), and the
 * payloads are built by pure functions so the contract can be tested without
 * rendering anything.
 *
 * ## The three things this file is careful about
 *
 * 1. **Where a value came from is shown, not implied** — `sourceOf` compares
 *    the live value with the seed and the seed's origin, and every control
 *    carries the answer. See `fields.tsx`.
 * 2. **Preference-seeded fields derive LIVE until the operator touches them.**
 *    `/api/state` arrives after the first render, so a `useState` seed taken
 *    before it would silently show the fallback instead of the preference.
 *    `null` in a choice slot means "the operator has not said".
 * 3. **The doors are called from here and nowhere else.** `api.runStart`,
 *    `api.runSettings` and the two agent-ticket helpers have exactly one
 *    caller each, guarded by `single-source.test.ts`.
 */

import { useMemo, useState } from 'react';
import { Bot, Play, ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@/components/ui';
import {
  api,
  automationPrefs,
  type AccountView,
  type PhaseView,
  type RunState,
  type SkillInfo,
} from '@/lib/api';
import { keys, useAccounts, useConsoleState, useMcp, useSkills } from '@/lib/queries';
import { startSession } from '@/lib/start-session';
import { cn } from '@/lib/cn';
import { DEFAULTS, EFFORTS, EFFORT_NOTE, MODEL_NOTE, MODELS } from '@/features/runs/defaults';
import { SkillPicker } from '@/features/run-setup/skill-picker';
import { McpPicker } from '@/features/run-setup/mcp-picker';
import {
  NumberField,
  PressField,
  SelectField,
  SetupField,
  ToggleField,
  sourceOf,
  type Source,
} from './fields';
import { RefreshMeters } from '@/components/refresh-meters';
import { bucketLabel } from '@/components/limits-widget';
import { field } from '@/components/ui/field';
import { PerPhase } from './per-phase';
import {
  MODES,
  PERMISSION_CHOICES,
  QA_PERMISSIONS,
  RUN_PERMISSIONS,
  SESSION_PERMISSIONS,
  buildLaunch,
  buildPrefs,
  buildRunPayload,
  buildTicket,
  mergedSkills,
  permissionModeFor,
  shows,
  submitLabel,
  type RunSetupContext,
  type RunSetupMode,
} from './modes';
import { EMPTY, formatPhases, runSetupSchema, type RunSetupValues } from './schema';

export interface RunSetupProps {
  mode: RunSetupMode;
  context?: RunSetupContext;
  /** The plan's phases — the per-phase matrix, and nothing else, reads them. */
  planPhases?: PhaseView[];
  /** What the plan asks every session to invoke / attach. Shown, never unticked here. */
  planSkills?: string[];
  planMcp?: string[];
  /** The plan's qa-mode; `off` is the only value that offers the QA toggle. */
  qaMode?: string;
  /** Whether the console may WRITE — a different flag from `allowRun`. */
  allowWrites?: boolean;
  /**
   * Whether `/api/skills` can be asked at all. It needs an open source
   * directory; without one the picker hides rather than 409ing, and — the part
   * a prop is needed for — the query is never issued. `agent.test.tsx` pins
   * that no request goes out, which is the honest version of "hides".
   */
  skillsEnabled?: boolean;
  /** Refuse to submit (a live claim on the phase, the session cap). */
  blocked?: boolean;
  blockedReason?: string;
  /** Called after a successful submit, with a session id where one was minted. */
  onDone?: (sessionId?: string) => void;
  /** `session` mode only: the launcher owns the pty, so it owns the call. */
  onLaunch?: (body: Record<string, unknown>) => void | Promise<void>;
  /** Rendered above the fields — claim banners, verdict notes, whatever the surface knows. */
  children?: React.ReactNode;
  /** Render the submit row. Off where the surface has its own (the run page's verb bar). */
  submit?: boolean;
  /** The muted line to the LEFT of the buttons — what this form opens on, usually. */
  footerNote?: React.ReactNode;
  /** A Cancel, when the surface is a dialog. Sits beside the submit, never instead of it. */
  cancel?: React.ReactNode;
  className?: string;
}

/** Where each field's opening value came from, so provenance can say so. */
type Origins = Partial<Record<keyof RunSetupValues, Source>>;

export function RunSetup({
  mode,
  context = {},
  planPhases = [],
  planSkills = [],
  planMcp = [],
  qaMode,
  allowWrites,
  skillsEnabled = true,
  blocked = false,
  blockedReason,
  onDone,
  onLaunch,
  children,
  submit = true,
  footerNote,
  cancel,
  className,
}: RunSetupProps) {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const { data: skillsState } = useSkills(skillsEnabled);
  const { data: mcpState } = useMcp();
  const { data: accountsState } = useAccounts();
  const prefs = automationPrefs(state);
  const defaultSkills = state?.defaultSkills ?? [];
  const accounts = accountsState?.accounts ?? [];
  const skills: SkillInfo[] = skillsState ?? [];
  const run = context.run ?? null;

  // The server's own list when it can say, this build's copy when it cannot —
  // an older server has no `models` on its state, and a form that offered
  // nothing would be worse than one offering a list that may lag by a release.
  const models = useMemo<readonly string[]>(
    () => (state?.models?.length ? state.models : MODELS),
    [state?.models],
  );

  const [seed, origins] = useMemo(
    () => seedFor(mode, { run, prefs, qaMode, context, defaultSkills }),
    // `prefs` and `defaultSkills` are fresh objects each render; their CONTENT
    // is what matters, so the identity used here is the content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, run, JSON.stringify(prefs), qaMode, JSON.stringify(context), defaultSkills.join(',')],
  );

  // `null` per field means "the operator has not said" — the seed keeps
  // answering, and keeps re-deriving as `/api/state` and the run arrive.
  const [touched, setTouched] = useState<Partial<RunSetupValues>>({});
  const [busy, setBusy] = useState(false);
  const values: RunSetupValues = { ...seed, ...touched };
  const parsed = runSetupSchema.safeParse(values);
  const errors = fieldErrors(parsed);

  const canQaToggle = qaMode === 'off' && allowWrites !== false;
  const canAutoRecover = state?.allowAgent === true;
  const on = (field: keyof RunSetupValues) => shows(mode, field);
  const src = (field: keyof RunSetupValues): Source | undefined =>
    mode === 'defaults' ? undefined : sourceOf(values[field], seed[field], origins[field] ?? 'defaults');

  // Settings ▸ Automation states a preference; a launch ticks a box for one
  // run. Same value, same field, two idioms — and the idiom matters here for a
  // mechanical reason as well as a readable one: the launch dialog's "there is
  // exactly one checkbox" pin is only meaningful while these stay apart.
  const Bool = mode === 'defaults' ? PressField : ToggleField;

  const set = <K extends keyof RunSetupValues>(field: K, next: RunSetupValues[K]) => {
    setTouched((prior) => ({ ...prior, [field]: next }));
    // Settings ▸ Automation saves as you go, one key at a time, merged
    // server-side: two tabs flipping different knobs must not overwrite each
    // other, and there is no "Save" on a page of preferences.
    if (mode === 'defaults') {
      const patch = buildPrefs({ ...values, [field]: next });
      const key = PREF_KEY[field];
      if (key) void savePref(client, { [key]: patch[key] });
    }
  };

  async function onSubmit() {
    if (blocked || busy) return;
    if (!parsed.success) {
      toast('Some fields need fixing before this can start.', 'warn');
      return;
    }
    setBusy(true);
    try {
      const door = MODES[mode].door;
      if (door === 'ticket') {
        const id = await startSession(
          client,
          buildTicket(mode as 'qa' | 'recovery', values, context, defaultSkills),
        );
        if (id) onDone?.(id);
        return;
      }
      if (door === 'launch') {
        await onLaunch?.(buildLaunch(values, mode, defaultSkills));
        onDone?.();
        return;
      }
      if (door === 'prefs') {
        await savePref(client, buildPrefs(values));
        toast('Defaults saved.', 'ok');
        onDone?.();
        return;
      }
      const slug = context.slug!;
      const payload = buildRunPayload(mode, values, context);
      if (door === 'runSettings') {
        await api.runSettings(slug, payload as never);
        toast('Applied — from the next phase.', 'ok');
      } else {
        await api.runStart(slug, payload as never);
        toast(mode === 'phase' ? `Running phase ${context.phase} of ${slug}` : `Continuing ${slug}`, 'ok');
        void client.invalidateQueries({ queryKey: keys.runs() });
        void client.invalidateQueries({ queryKey: keys.plans() });
        void client.invalidateQueries({ queryKey: keys.stats() });
        void client.invalidateQueries({ queryKey: keys.state() });
      }
      onDone?.();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const permissionOptions = (
    mode === 'qa' ? QA_PERMISSIONS : MODES[mode].sessionPermissions ? SESSION_PERMISSIONS : RUN_PERMISSIONS
  ).map((choice) => [choice, PERMISSION_CHOICES[choice]] as const);

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      {children}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {on('model') && (
          <SelectField
            label="Model"
            source={src('model')}
            value={values.model}
            placeholder="default — this machine’s"
            options={models.map((name) => [name, MODEL_NOTE[name] ?? name] as const)}
            onChange={(next) => set('model', next)}
          />
        )}
        {on('effort') && (
          <SelectField
            label="Effort"
            source={src('effort')}
            value={values.effort}
            options={EFFORTS.map((level) => [level, EFFORT_NOTE[level] ?? level] as const)}
            onChange={(next) => set('effort', next)}
          />
        )}
        {on('accountId') && (
          <SetupField
            label="Account"
            source={src('accountId')}
            hint={
              <>
                <strong>auto</strong> picks the account with the most headroom, and a run that hits a wall
                moves to one that can pay — see “On usage limit”. Meters are polled on a budget, so re-read
                them if a window just reset.
              </>
            }
          >
            {({ id, describedBy }) => (
              <div className="flex min-w-0 items-center gap-2">
                <select
                  id={id}
                  aria-describedby={describedBy}
                  className={cn(field, 'min-w-0 flex-1')}
                  value={values.accountId}
                  onChange={(event) => set('accountId', event.target.value)}
                >
                  <option value="auto">auto — the account with the most headroom</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </option>
                  ))}
                  {accounts.length === 0 && <option value="default">machine login</option>}
                </select>
                {/* On the launch form as well as the panels: the moment that
                    matters for "which account can run this" is the moment
                    somebody is choosing one. */}
                <RefreshMeters variant="ghost" label="" className="shrink-0" />
              </div>
            )}
          </SetupField>
        )}
        {on('onLimit') && (
          <SelectField
            label="On usage limit"
            source={src('onLimit')}
            value={values.onLimit}
            options={[
              ['switch', 'switch account, else wait'],
              ['wait', 'wait for the reset'],
              ['pause', 'pause and ask me'],
            ]}
            onChange={(next) => set('onLimit', next as RunSetupValues['onLimit'])}
          />
        )}
        {on('autonomy') && (
          <SelectField
            label="If something is unclear"
            source={src('autonomy')}
            value={values.autonomy}
            options={[
              ['keep-going', 'Keep going where it safely can'],
              ['halt-on-everything', 'Stop and ask me'],
            ]}
            onChange={(next) => set('autonomy', next as RunSetupValues['autonomy'])}
          />
        )}
        {on('permissionProfile') && (
          <SelectField
            label="Permissions"
            source={src('permissionProfile')}
            value={values.permissionProfile}
            options={permissionOptions}
            hint={PERMISSION_HINT[values.permissionProfile]}
            onChange={(next) => {
              set('permissionProfile', next as RunSetupValues['permissionProfile']);
              // The two spellings of one choice stay in step: a session's CLI
              // mode is derived, never a second thing to keep aligned by hand.
              set('permissionMode', permissionModeFor(next));
            }}
          />
        )}
        {on('phaseBudgetUsd') && (
          <NumberField
            label="Budget per phase ($)"
            source={src('phaseBudgetUsd')}
            error={errors.phaseBudgetUsd}
            value={values.phaseBudgetUsd}
            min={0}
            step={0.5}
            onChange={(next) => set('phaseBudgetUsd', next)}
          />
        )}
        {on('runBudgetUsd') && (
          <NumberField
            label="Budget for the run ($)"
            source={src('runBudgetUsd')}
            error={errors.runBudgetUsd}
            value={values.runBudgetUsd}
            min={0}
            step={1}
            onChange={(next) => set('runBudgetUsd', next)}
          />
        )}
        {on('maxParallel') && (
          <NumberField
            label="Max parallel"
            hint={`Lanes this run may hold at once${
              state?.concurrency?.max ? ` — this console allows ${state.concurrency.max}` : ''
            }. Empty means the console's own ceiling.`}
            source={src('maxParallel')}
            error={errors.maxParallel}
            value={values.maxParallel}
            min={1}
            step={1}
            placeholder="console default"
            onChange={(next) => set('maxParallel', next)}
          />
        )}
        {on('maxConsecutiveFailures') && (
          <NumberField
            label="Stop after N failures"
            hint="Consecutive failed phases before the run halts. Empty leaves the run's own ceiling."
            source={src('maxConsecutiveFailures')}
            error={errors.maxConsecutiveFailures}
            value={values.maxConsecutiveFailures}
            min={1}
            step={1}
            placeholder="run default"
            onChange={(next) => set('maxConsecutiveFailures', next)}
          />
        )}
        {on('gitMode') && (
          <SelectField
            label="Branch"
            source={src('gitMode')}
            value={values.gitMode}
            options={[
              ['default-branch', 'Work on the current branch'],
              [
                'new-branch',
                context.slug
                  ? `Create a work branch per run (pe/${context.slug})`
                  : 'Create a work branch per run',
              ],
            ]}
            onChange={(next) => set('gitMode', next as RunSetupValues['gitMode'])}
          />
        )}
        {on('onlyPhases') && (
          <SetupField
            label="Only these phases"
            hint="Empty runs the whole plan. Ranges are fine: 1, 3, 5-7."
            source={src('onlyPhases')}
            error={errors.onlyPhases}
          >
            {({ id, describedBy, invalid }) => (
              <input
                id={id}
                type="text"
                inputMode="numeric"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                className="min-h-(--tap-min) w-full rounded border border-rule bg-ground px-2 text-sm text-ink"
                placeholder="the whole plan"
                value={values.onlyPhases}
                onChange={(event) => set('onlyPhases', event.target.value)}
              />
            )}
          </SetupField>
        )}
      </div>

      {on('gitMode') && on('openPr') && values.gitMode === 'new-branch' && (
        <Bool
          label="Open a PR when the plan completes"
          hint="The final phase pushes the branch and opens the PR — after one approval tap on the push. Force-pushes stay denied outright."
          source={src('openPr')}
          value={values.openPr}
          onChange={(next) => set('openPr', next)}
        />
      )}
      {/* Said rather than simply hidden: a row that disappears reads as a
          setting that does not exist, and this one is only inapplicable. */}
      {mode === 'defaults' && on('openPr') && values.gitMode !== 'new-branch' && (
        <p className="text-2xs text-ink-faint">
          PR-on-completion applies to work-branch runs; pick “Create a work branch per run” to use it.
        </p>
      )}

      {on('prompt') && (
        <SetupField label="First prompt (optional)" source={src('prompt')}>
          {({ id, describedBy }) => (
            // text-base = 16px — below that iOS zooms the page on focus.
            <textarea
              id={id}
              aria-describedby={describedBy}
              className="min-h-28 w-full rounded border border-rule bg-ground p-2 text-base"
              placeholder="Sent as your first message. Leave empty to just open the session."
              maxLength={16000}
              value={values.prompt}
              onChange={(event) => set('prompt', event.target.value)}
            />
          )}
        </SetupField>
      )}

      {on('attachDefaultSkills') && defaultSkills.length > 0 && (
        <PressField
          label="Attach default skills"
          hint={
            <>
              This machine's list:{' '}
              {defaultSkills.map((s) => (
                <code key={s} className="mr-1">
                  {s}
                </code>
              ))}
            </>
          }
          on="Attached"
          source={src('attachDefaultSkills')}
          value={values.attachDefaultSkills}
          onChange={(next) => set('attachDefaultSkills', next)}
        />
      )}
      {on('attachDefaultSkills') && defaultSkills.length === 0 && mode === 'defaults' && (
        <PressField
          label="Attach default skills to new sessions"
          hint="This machine has no default skills configured."
          on="Attached"
          value={values.attachDefaultSkills}
          onChange={(next) => set('attachDefaultSkills', next)}
        />
      )}

      {on('skills') && skillsEnabled && (
        <SkillPicker
          skills={skills}
          chosen={values.skills}
          planSkills={planSkills}
          defaultSkills={defaultSkills}
          onChange={(next) => set('skills', next)}
          label={
            mode === 'qa'
              ? 'Skills for this review'
              : mode === 'session'
                ? 'Skills for this session'
                : 'Skills for this run'
          }
        />
      )}

      {on('mcpServers') && (
        <>
          {/* Servers are attached at a PHASE boundary, never mid-phase:
              connecting one busts the prompt cache and re-reads the context. */}
          <McpPicker
            servers={mcpState?.servers ?? []}
            chosen={values.mcpServers}
            planServers={planMcp}
            onChange={(next) => set('mcpServers', next)}
            label="MCP servers for this run"
            note="Checked before the phase boards, so a wall costs a probe rather than an hour."
          />
          {(values.mcpServers.length > 0 || planMcp.length > 0) && on('mcpPolicy') && (
            <SelectField
              label="If one will not connect"
              hint="A phase whose plan says it requires its servers still parks — this cannot overrule that."
              source={src('mcpPolicy')}
              value={values.mcpPolicy}
              options={[
                ['continue', 'Run the phase without it'],
                ['require', 'Park the phase'],
              ]}
              onChange={(next) => set('mcpPolicy', next as RunSetupValues['mcpPolicy'])}
            />
          )}
        </>
      )}
      {on('mcpPolicy') && !on('mcpServers') && (
        <SelectField
          label="When an MCP server is unavailable"
          hint="A plan or a single phase can still demand its servers — this is only where every run starts."
          value={values.mcpPolicy}
          options={[
            ['continue', 'Continue and warn'],
            ['require', 'Park the phase'],
          ]}
          onChange={(next) => set('mcpPolicy', next as RunSetupValues['mcpPolicy'])}
        />
      )}

      {/* The review's own activation sentence — a different act from the run
          toggle below it, and the only checkbox this dialog has. */}
      {on('qa') && mode === 'qa' && qaMode === 'off' && (
        <ToggleField
          label={
            <>
              Turn QA on for this plan (<code className="font-mono">--qa</code>)
            </>
          }
          hint={
            allowWrites === false ? (
              <>
                Writes are off — restart the console with <code className="font-mono">--allow-writes</code> to
                turn QA on from here. The review still runs; its verdict just gates nothing until then.
              </>
            ) : (
              <>
                Creates <code className="font-mono">test-status.md</code> so verdicts gate dependents. Phases
                that finished before now are recorded as <em>waived</em>, so turning it on does not
                retroactively hold the board. Without this the review still runs — its verdict just gates
                nothing.
              </>
            )
          }
          source={src('qa')}
          value={values.qa}
          disabledReason={
            allowWrites === false
              ? 'Writes are disabled. Restart the console with --allow-writes.'
              : undefined
          }
          onChange={(next) => set('qa', next)}
        />
      )}

      {on('qa') && mode !== 'qa' && (qaMode === 'off' || mode === 'defaults') && (
        <Bool
          label={
            mode === 'defaults' ? 'Turn the QA gate on for new runs' : 'Turn the QA gate on for this plan'
          }
          hint="Each finished phase then waits for an independent review. Phases that finished before now are recorded as waived, so turning it on does not retroactively hold the board."
          source={src('qa')}
          value={values.qa}
          disabledReason={
            mode !== 'defaults' && !canQaToggle
              ? 'Writes are disabled. Restart the console with --allow-writes.'
              : undefined
          }
          onChange={(next) => set('qa', next)}
        />
      )}

      {on('autoRecover') && (
        <Bool
          label={mode === 'defaults' ? 'Auto-recover halted runs' : 'Auto-recover halts'}
          hint="A halt an agent can clear (failed verification, missing handoff, a crash) launches the fix agent by itself — at most 2 tries per phase, never the same failure twice — and the run resumes when the board reads fixed."
          source={src('autoRecover')}
          value={values.autoRecover}
          disabledReason={
            mode !== 'defaults' && !canAutoRecover
              ? 'Auto-recovery needs --allow-agent — the healer is an agent session.'
              : undefined
          }
          onChange={(next) => set('autoRecover', next)}
        />
      )}

      {on('phaseOptions') && planPhases.length > 0 && (
        <PerPhase
          planPhases={planPhases}
          overrides={values.phaseOptions}
          runModel={values.model}
          runEffort={values.effort}
          models={models}
          skills={skills}
          runSkills={values.skills}
          servers={mcpState?.servers ?? []}
          runMcp={values.mcpServers}
          onChange={(next) => set('phaseOptions', next)}
        />
      )}

      {submit && MODES[mode].door !== 'prefs' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-2xs text-ink-faint">
            {blocked && blockedReason ? blockedReason : footerNote}
          </span>
          <div className="flex gap-2">
            {cancel}
            <Button
              variant="action"
              disabled={busy || blocked || !parsed.success}
              title={blocked ? blockedReason : undefined}
              onClick={() => void onSubmit()}
            >
              {mode === 'qa' ? (
                <ShieldCheck size={15} aria-hidden />
              ) : mode === 'session' ? (
                <Play size={15} aria-hidden />
              ) : (
                <Bot size={15} aria-hidden />
              )}{' '}
              {busy ? 'Starting…' : submitLabel(mode, context)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * How an account reads in the picker: who it is, then EVERY meter it has.
 *
 * It used to show the 5-hour window alone, which is the wrong half of the
 * question on a weekly plan — an account at 12% for the session and 98% for
 * the week reads as the obvious choice and is the one that will stop first.
 * The buckets are data, not schema (`five_hour`, `seven_day`,
 * `seven_day_opus`, whatever ships next), so they are listed as they come,
 * worst first, and a name this build has never seen still renders.
 */
function accountLabel(account: AccountView): string {
  const who = account.builtIn
    ? `machine login${account.email ? ` (${account.email})` : ''}`
    : (account.name ?? account.email ?? account.id);
  const meters = Object.entries(account.usage?.buckets ?? {})
    .sort(([, a], [, b]) => b.utilization - a.utilization)
    .map(([key, bucket]) => `${shortBucket(key)} ${Math.round(bucket.utilization)}%`);
  // A wall already hit outranks any percentage: it is the reason this account
  // cannot be picked, and the picker must not read as though it could.
  const walled = Object.keys(account.limitedUntil ?? {});
  return [
    who,
    walled.length
      ? `— at its ${shortBucket(walled[0]!)} limit`
      : meters.length
        ? `— ${meters.join(' · ')}`
        : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** `five_hour` → `5h`, `seven_day` → `wk`, `seven_day_opus` → `wk opus`. */
function shortBucket(key: string): string {
  if (key === 'five_hour') return '5h';
  if (key === 'seven_day') return 'wk';
  const model = /^seven_day_(.+)$/.exec(key)?.[1];
  return model ? `wk ${model}` : bucketLabel(key);
}

/** What each toggle in `defaults` mode is called on the server. */
const PREF_KEY: Partial<Record<keyof RunSetupValues, string>> = {
  attachDefaultSkills: 'attachDefaultSkills',
  qa: 'qaByDefault',
  gitMode: 'gitMode',
  openPr: 'openPrOnComplete',
  autoRecover: 'autoRecoverByDefault',
  mcpPolicy: 'mcpPolicy',
};

async function savePref(client: ReturnType<typeof useQueryClient>, patch: Record<string, unknown>) {
  try {
    await api.savePrefs(patch);
    await client.invalidateQueries({ queryKey: keys.state() });
  } catch (error) {
    toast(String((error as Error).message ?? error), 'error');
  }
}

/** One line under the permission select, so the cost is read while choosing. */
const PERMISSION_HINT: Record<string, string> = {
  guarded:
    'Commits, installs, merges and fetches raise a card. The deny list — pushes, destructive git, deploys, publishes — is refused outright and no card can approve it.',
  trusted:
    'Nothing raises a card. The deny list still holds, and still holds with this console dead — it is enforced by the CLI, not by the hook.',
  bypass:
    'Nothing raises a card and the CLI stops asking too (--permission-mode bypassPermissions). Requires the bypass disclaimer to have been accepted once, interactively, on this machine; without it the CLI silently downgrades and refuses every edit.',
  plan: 'Read-only until a plan is approved in the session itself.',
  auto: 'The CLI decides what needs asking.',
  dontAsk: 'Refuses rather than prompting.',
};

/**
 * The opening values, and where each came from.
 *
 * The order of precedence is the same everywhere and is the reason this is one
 * function: **the run's own record beats a preference beats a shipped default.**
 * A resume that re-derived from preferences would silently re-attach something
 * the operator had unticked, and a fresh run that ignored preferences would
 * make Settings ▸ Automation decorative.
 */
function seedFor(
  mode: RunSetupMode,
  input: {
    run: RunState | null;
    prefs: ReturnType<typeof automationPrefs>;
    qaMode?: string;
    context: RunSetupContext;
    defaultSkills: string[];
  },
): [RunSetupValues, Origins] {
  const { run, prefs, context, defaultSkills } = input;
  const origins: Origins = {};
  const mark = <K extends keyof RunSetupValues>(field: K, from: Source) => {
    origins[field] = from;
  };
  const values: RunSetupValues = { ...EMPTY };

  if (mode === 'defaults') {
    values.attachDefaultSkills = prefs.attachDefaultSkills;
    values.qa = prefs.qaByDefault;
    values.gitMode = prefs.gitMode;
    values.openPr = prefs.openPrOnComplete;
    values.autoRecover = prefs.autoRecoverByDefault;
    values.mcpPolicy = prefs.mcpPolicy;
    return [values, origins];
  }

  if (mode === 'qa' || mode === 'recovery') {
    // A review opens on what the PLAN asked for this phase, when it asked;
    // a recovery opens on nothing, because "the machine's default" is the
    // honest answer for a session whose job is to read and fix.
    values.model = mode === 'qa' ? (context.qaModel ?? '') : '';
    values.effort = mode === 'qa' ? (context.qaEffort ?? '') : '';
    if (mode === 'qa' && (context.qaModel || context.qaEffort)) {
      mark('model', 'plan');
      mark('effort', 'plan');
    }
    values.permissionProfile = 'guarded';
    // The activation box opens TICKED: somebody asking for a review on a plan
    // that gates nothing usually means it to start gating.
    values.qa = mode === 'qa' && Boolean(context.activate);
    values.skills = context.planSkills ?? [];
    if (context.planSkills?.length) mark('skills', 'plan');
    values.attachDefaultSkills = prefs.attachDefaultSkills && defaultSkills.length > 0;
    return [values, origins];
  }

  if (mode === 'session' || mode === 'plan') {
    values.model = DEFAULTS.model;
    values.effort = DEFAULTS.effort;
    values.permissionProfile = 'guarded';
    values.permissionMode = '';
    // The wizard's ticket has no attach flag, so a ticked box means the names
    // ride inside `skills` — `buildLaunch` does the merge.
    values.attachDefaultSkills = prefs.attachDefaultSkills && defaultSkills.length > 0;
    return [values, origins];
  }

  // start | continue | phase | live — the run answers for itself where it can.
  values.model = run?.model ?? DEFAULTS.model;
  values.effort = run?.effort ?? (run ? '' : DEFAULTS.effort);
  values.autonomy = run?.autonomy ?? DEFAULTS.autonomy;
  // Absent has always meant `guarded` on disk for an EXISTING run; a run that
  // does not exist yet opens on the client default.
  values.permissionProfile = run?.permissionProfile ?? (run ? 'guarded' : DEFAULTS.permissionProfile);
  values.accountId = run?.accountId ?? 'default';
  values.onLimit = run?.onLimit ?? 'switch';
  values.phaseBudgetUsd = run?.phaseBudgetUsd == null ? '' : String(run.phaseBudgetUsd);
  values.runBudgetUsd = run?.runBudgetUsd == null ? '' : String(run.runBudgetUsd);
  values.gitMode = run?.gitMode ?? (run ? 'default-branch' : prefs.gitMode);
  values.openPr = run?.openPr ?? (run ? true : prefs.openPrOnComplete);
  values.qa = false;
  // A run that EXISTS answers for itself, empty list included: `state.skills`
  // is deleted when empty, so an absent list on a real run means the operator
  // turned them all off — re-seeding the machine defaults over that would make
  // the box impossible to untick.
  values.skills = run ? (run.skills ?? []) : [];
  values.attachDefaultSkills = run ? false : prefs.attachDefaultSkills && defaultSkills.length > 0;
  values.mcpServers = run?.mcpServers ?? [];
  // An EXISTING run with no `mcpPolicy` is `continue` (absent means that on
  // disk, including on runs written before the key existed), so a resume must
  // not silently pick up a `require` preference the run never had.
  values.mcpPolicy = run?.mcpPolicy ?? (run ? 'continue' : prefs.mcpPolicy);
  values.autoRecover = run ? Boolean(run.autoRecover) : prefs.autoRecoverByDefault;
  values.maxParallel = run?.maxParallel ? String(run.maxParallel) : '';
  values.maxConsecutiveFailures = run?.maxConsecutiveFailures ? String(run.maxConsecutiveFailures) : '';
  values.onlyPhases = mode === 'phase' ? '' : formatPhases(run?.onlyPhases);
  values.phaseOptions = run?.phaseOptions ?? {};

  for (const field of RUN_SEEDED) mark(field, run ? 'run' : 'defaults');
  return [values, origins];
}

/** Fields whose opening value comes from the run when there is one. */
const RUN_SEEDED = [
  'model',
  'effort',
  'autonomy',
  'permissionProfile',
  'accountId',
  'onLimit',
  'phaseBudgetUsd',
  'runBudgetUsd',
  'gitMode',
  'openPr',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'autoRecover',
  'maxParallel',
  'maxConsecutiveFailures',
  'onlyPhases',
  'phaseOptions',
] as const satisfies readonly (keyof RunSetupValues)[];

/** The resolver's messages, keyed by field, for the controls to render. */
function fieldErrors(parsed: ReturnType<typeof runSetupSchema.safeParse>): Record<string, string> {
  if (parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export { mergedSkills };
