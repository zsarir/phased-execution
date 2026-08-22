/**
 * RunSetup — the field matrix, and what each mode sends.
 *
 * The matrix is the contract the consolidation exists to state: a recovery
 * offers model, effort and skills and no permission select; a phase launch
 * carries the git section with the PR box alive only under the work-branch
 * mode; a live run is offered none of the three fields a settings patch may
 * not carry. The payloads are asserted VERBATIM, including their omissions,
 * because they are what the server validates — a key that quietly stops being
 * sent degrades to a preference and the run looks healthy while being a
 * different run from the one that was asked for.
 *
 * The payload builders are pure (`modes.ts`), so most of this suite needs no
 * DOM at all. That is the point of putting them there: a contract you can only
 * exercise by rendering a dialog and clicking a button is a contract nobody
 * re-checks.
 */

import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { RunState } from '@/lib/api';
import { EMPTY, type RunSetupValues } from './schema';
import {
  buildLaunch,
  buildPrefs,
  buildRunPayload,
  buildTicket,
  mergedSkills,
  permissionModeFor,
  permissionChoiceFor,
  shows,
} from './modes';

const { state, skills, runStart, runSettings, savePrefs } = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  runSettings: vi.fn(),
  savePrefs: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, skills, runStart, runSettings, savePrefs } };
});

const RUN = {
  id: 'run-1',
  slug: 'alpha',
  status: 'halted',
  model: 'sonnet',
  effort: 'high',
  autonomy: 'keep-going',
  permissionProfile: 'trusted',
  skills: ['design-review'],
  phaseBudgetUsd: 5,
  runBudgetUsd: 40,
  phases: {},
} as unknown as RunState;

const values = (over: Partial<RunSetupValues> = {}): RunSetupValues => ({ ...EMPTY, ...over });

async function mount(props: Record<string, unknown>, consoleState: Record<string, unknown> = {}) {
  state.mockResolvedValue({ prefs: {}, defaultSkills: ['graph-tool'], ...consoleState });
  const client = new QueryClient(queryClientConfig);
  const { RunSetup } = await import('./run-setup');
  const Setup = RunSetup as unknown as (props: Record<string, unknown>) => ReactElement;
  return render(
    <QueryClientProvider client={client}>
      <Setup {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  skills.mockResolvedValue([]);
  runStart.mockResolvedValue({ run: null });
  runSettings.mockResolvedValue({ run: null });
  savePrefs.mockResolvedValue({});
});

describe('the field matrix', () => {
  it('a recovery offers model, effort and skills — and no permissions', () => {
    expect(shows('recovery', 'model')).toBe(true);
    expect(shows('recovery', 'effort')).toBe(true);
    expect(shows('recovery', 'skills')).toBe(true);
    expect(shows('recovery', 'permissionProfile')).toBe(false);
    expect(shows('recovery', 'gitMode')).toBe(false);
  });

  it('an agent ticket is never offered a budget, a branch or a phase matrix', () => {
    for (const mode of ['recovery', 'qa', 'session', 'plan'] as const) {
      for (const field of ['phaseBudgetUsd', 'runBudgetUsd', 'gitMode', 'phaseOptions'] as const) {
        expect(shows(mode, field), `${mode} shows ${field}`).toBe(false);
      }
    }
  });

  it('a narrow phase launch does not reopen the run’s whole configuration', () => {
    // "Run only this one" is a choice, not a re-read of the run. The three it
    // withholds are inherited from the run instead — asserted in the payloads.
    for (const field of ['autonomy', 'phaseBudgetUsd', 'runBudgetUsd', 'phaseOptions'] as const) {
      expect(shows('phase', field)).toBe(false);
    }
    expect(shows('continue', 'phaseOptions')).toBe(true);
  });

  it('the PR box follows the branch mode', async () => {
    await mount({ mode: 'phase', context: { slug: 'alpha', phase: 3, run: null } });
    await screen.findByText('Branch');
    expect(screen.queryByText(/Open a PR when the plan completes/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'new-branch' } });
    expect(await screen.findByText(/Open a PR when the plan completes/)).toBeTruthy();
  });

  it('says where each value came from', async () => {
    // The whole reason a preference-seeded dialog is readable: a value that is
    // the run's own says so, and one the operator typed says something else.
    await mount({ mode: 'continue', context: { slug: 'alpha', run: RUN } });
    await screen.findByText('Branch');
    expect(screen.getAllByText('from this run').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/Budget for the run/), { target: { value: '99' } });
    expect(await screen.findByText('changed here')).toBeTruthy();
  });

  it('a preference page states its defaults without provenance noise', async () => {
    // "from defaults" beside every field of the defaults page is not
    // information — and the accessible label is what `getByLabelText` reads.
    await mount({ mode: 'defaults' });
    expect(await screen.findByLabelText('Branch')).toBeTruthy();
    expect(screen.queryByText('from defaults')).toBeNull();
  });
});

describe('the payloads', () => {
  it('a phase launch sends exactly what the form shows, scoped to its phase', () => {
    expect(
      buildRunPayload(
        'phase',
        values({
          model: 'sonnet',
          effort: 'high',
          onLimit: 'switch',
          permissionProfile: 'trusted',
          skills: ['design-review'],
          attachDefaultSkills: true,
          qa: true,
        }),
        { slug: 'alpha', phase: 3, run: RUN },
      ),
    ).toEqual({
      model: 'sonnet',
      effort: 'high',
      // The deliberate default: switch to the account with headroom at the
      // usage wall, degrading to `wait` when there is only one login.
      onLimit: 'switch',
      // Inherited from the run, not shown: a narrow launch does not re-decide
      // the run's posture or its budgets.
      autonomy: 'keep-going',
      phaseBudgetUsd: 5,
      runBudgetUsd: 40,
      permissionProfile: 'trusted',
      skills: ['design-review'],
      // Always sent as shown. `continue` is the shipped default: an unreachable
      // MCP server makes a phase report what it could not do, rather than
      // stopping the plan.
      mcpPolicy: 'continue',
      attachDefaultSkills: true,
      gitMode: 'default-branch',
      qa: true,
      // Always sent as shown, never omitted: an explicit false on a resume
      // returns the run to the off state rather than to a preference.
      autoRecover: false,
      resumeRunId: 'run-1',
      onlyPhases: [3],
    });
  });

  it('a continue resumes the run and never narrows it', () => {
    const payload = buildRunPayload('continue', values(), { slug: 'alpha', run: RUN });
    expect(payload.resumeRunId).toBe('run-1');
    expect('onlyPhases' in payload).toBe(false);
  });

  it('a continue that WAS scoped keeps saying so, because the box does', () => {
    const payload = buildRunPayload('continue', values({ onlyPhases: '2, 4-5' }), {
      slug: 'alpha',
      run: RUN,
    });
    expect(payload.onlyPhases).toEqual([2, 4, 5]);
  });

  it('a start never resumes a run that already finished', () => {
    const finished = { ...RUN, status: 'finished' } as RunState;
    expect('resumeRunId' in buildRunPayload('start', values(), { slug: 'alpha', run: finished })).toBe(false);
    expect(buildRunPayload('start', values(), { slug: 'alpha', run: RUN }).resumeRunId).toBe('run-1');
  });

  it('omits what absence means, and sends null where blank is a choice', () => {
    const payload = buildRunPayload('start', values({ model: 'opus' }), { slug: 'alpha' });
    // Absence is their meaning on disk — a run that never named servers must
    // keep meaning what it meant.
    for (const key of ['mcpServers', 'attachDefaultSkills', 'qa', 'onlyPhases', 'maxParallel']) {
      expect(key in payload, `${key} should be omitted when empty`).toBe(false);
    }
    // `null` is "no ceiling", which IS a choice; absence would mean "leave it".
    expect(payload.phaseBudgetUsd).toBeNull();
    expect(payload.runBudgetUsd).toBeNull();
  });

  it('a live patch carries the numbers it was given', () => {
    const payload = buildRunPayload(
      'live',
      values({ maxParallel: '2', maxConsecutiveFailures: '5', phaseBudgetUsd: '3.5' }),
      { slug: 'alpha', run: RUN },
    );
    expect(payload.maxParallel).toBe(2);
    expect(payload.maxConsecutiveFailures).toBe(5);
    expect(payload.phaseBudgetUsd).toBe(3.5);
    expect('resumeRunId' in payload).toBe(false);
  });

  it('a recovery ticket merges the attached defaults into the skills it sends', () => {
    const body = buildTicket(
      'recovery',
      values({ attachDefaultSkills: true }),
      { slug: 'alpha', recoveryClass: 'plan-repair' },
      ['graph-tool'],
    );
    expect(body.intent).toBe('recovery');
    expect(body.recoveryClass).toBe('plan-repair');
    expect(body.skills).toEqual(['graph-tool']);
    // A ticket has no attach flag for the server to union in, so the merge is
    // the caller's — and an empty model is an omission, not a value to check.
    expect('model' in body).toBe(false);
    expect('permissionProfile' in body).toBe(false);
    expect('attachDefaultSkills' in body).toBe(false);
  });

  it('a review activates the gate only when it was asked to AND may', () => {
    const ticked = values({ qa: true });
    expect(buildTicket('qa', ticked, { slug: 'a', phase: 2, activate: true }, []).activate).toBe(true);
    // Ticked, but the plan already gates — the context says so, and the ticket
    // must not ask the server to create `test-status.md` again.
    expect('activate' in buildTicket('qa', ticked, { slug: 'a', phase: 2 }, [])).toBe(false);
    // Offered and unticked.
    expect('activate' in buildTicket('qa', values(), { slug: 'a', phase: 2, activate: true }, [])).toBe(
      false,
    );
  });

  it('a plan-authoring ticket carries no permission mode at all', () => {
    // The omission IS the choice: the server defaults a plan intent to plan
    // mode, and a mode chosen here could write a plan nobody approved.
    const body = buildLaunch(values({ attachDefaultSkills: true }), 'plan', ['graph-tool']);
    expect('permissionMode' in body).toBe(false);
    expect(body.skills).toEqual(['graph-tool']);
  });

  it('a session ticket spells its permission choice as a CLI mode', () => {
    const body = buildLaunch(values({ permissionProfile: 'trusted', permissionMode: 'acceptEdits' }));
    expect(body.permissionMode).toBe('acceptEdits');
    expect('accountId' in body).toBe(false);
  });

  it('the Automation patch is the six run-shaped preferences', () => {
    expect(buildPrefs(values({ qa: true, autoRecover: true }))).toEqual({
      attachDefaultSkills: false,
      qaByDefault: true,
      gitMode: 'default-branch',
      openPrOnComplete: true,
      autoRecoverByDefault: true,
      mcpPolicy: 'continue',
    });
  });
});

describe('one permission vocabulary, two spellings', () => {
  it('round-trips every choice a session can be started under', () => {
    for (const choice of ['trusted', 'plan', 'auto', 'dontAsk'] as const) {
      expect(permissionChoiceFor(permissionModeFor(choice))).toBe(choice);
    }
    // Guarded is the CLI's own default, which the runner's vocabulary writes as
    // an omission rather than a value — so it round-trips through `''`.
    expect(permissionModeFor('guarded')).toBe('');
    expect(permissionChoiceFor('')).toBe('guarded');
    expect(permissionChoiceFor('manual')).toBe('guarded');
  });
});

describe('skills', () => {
  it('merges the machine list only when it is attached, without duplicates', () => {
    expect(mergedSkills(values({ skills: ['a'], attachDefaultSkills: true }), ['a', 'b'])).toEqual([
      'a',
      'b',
    ]);
    expect(mergedSkills(values({ skills: ['a'] }), ['b'])).toEqual(['a']);
  });
});

describe('the submits', () => {
  it('a phase launch reaches the run door once', async () => {
    await mount({ mode: 'phase', context: { slug: 'alpha', phase: 3, run: RUN } });
    fireEvent.click(await screen.findByRole('button', { name: 'Run phase 3' }));
    await waitFor(() => expect(runStart).toHaveBeenCalledTimes(1));
    expect(runStart.mock.calls[0]![0]).toBe('alpha');
    expect((runStart.mock.calls[0]![1] as Record<string, unknown>).onlyPhases).toEqual([3]);
  });

  it('a live run patches its settings rather than starting anything', async () => {
    await mount({ mode: 'live', context: { slug: 'alpha', run: RUN } });
    fireEvent.click(await screen.findByRole('button', { name: /Apply from next phase/ }));
    await waitFor(() => expect(runSettings).toHaveBeenCalledTimes(1));
    expect(runStart).not.toHaveBeenCalled();
  });

  it('a claimed phase refuses, and the button says so', async () => {
    await mount({
      mode: 'phase',
      context: { slug: 'alpha', phase: 4, run: null },
      blocked: true,
      blockedReason: 'Claimed by someone/else',
    });
    const submit = await screen.findByRole('button', { name: /Run phase 4/ });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(runStart).not.toHaveBeenCalled();
  });

  it('a bad number refuses before the door does', async () => {
    // The server would 400 with the same sentence; saying it here costs a
    // round trip less and points at the field.
    await mount({ mode: 'start', context: { slug: 'alpha', run: null } });
    await screen.findByText('Branch');
    fireEvent.change(screen.getByLabelText(/Max parallel/), { target: { value: '0' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number between 1 and 99/);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(runStart).not.toHaveBeenCalled();
  });

  it('the defaults page saves one key per change, never the whole object', async () => {
    // Two tabs flipping different knobs must not overwrite each other — the
    // server merges, and only because the client sends a delta.
    await mount({ mode: 'defaults' });
    fireEvent.change(await screen.findByLabelText('Branch'), { target: { value: 'new-branch' } });
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ gitMode: 'new-branch' }));
  });
});
