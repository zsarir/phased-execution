/**
 * The unified launch dialog — the field matrix and what each submit sends.
 *
 * The matrix is the contract: permissions are run-profiles on run launches and
 * QA-profiles on reviews and absent on recoveries; the git section exists only
 * where a run is being minted, with the PR checkbox alive only under the
 * work-branch mode; and the Automation preferences are the OPENING values,
 * overridable per launch. The submit payloads are asserted verbatim because
 * they are what the server validates — a field that quietly stopped being sent
 * would degrade to the preference without anyone seeing it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { RunState } from '@/lib/api';

const { state, skills, runStart, agentTicket } = vi.hoisted(() => ({
  state: vi.fn(),
  skills: vi.fn(),
  runStart: vi.fn(),
  agentTicket: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, skills, runStart, agentTicket } };
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

async function mount(
  request: unknown,
  prefs: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  state.mockResolvedValue({ prefs, defaultSkills: ['graph-tool'], ...extra });
  const client = new QueryClient(queryClientConfig);
  const { LaunchDialog } = await import('./launch-dialog');
  return render(
    <QueryClientProvider client={client}>
      <LaunchDialog request={request as never} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  skills.mockResolvedValue([]);
  runStart.mockResolvedValue({ run: null });
  agentTicket.mockResolvedValue({ sessionId: 'sess-new' });
});

describe('the field matrix', () => {
  it('a recovery offers model, effort and skills — and no permission select', async () => {
    await mount({ kind: 'recovery', recoveryClass: 'plan-repair', slug: 'alpha' });
    await screen.findByText('Model');
    expect(screen.getByText('Effort')).toBeTruthy();
    expect(screen.queryByText('Permissions')).toBeNull();
    expect(screen.queryByText('Branch')).toBeNull();
    expect(screen.getByRole('button', { name: /Repair the plan with a new agent/ })).toBeTruthy();
  });

  it('a phase launch carries the git section, and the PR box follows the branch mode', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null });
    await screen.findByText('Branch');
    expect(screen.queryByText(/Open a PR when the plan completes/)).toBeNull();
    const branch = screen
      .getAllByRole('combobox')
      .find((el) => (el as HTMLSelectElement).value === 'default-branch')!;
    fireEvent.change(branch, { target: { value: 'new-branch' } });
    expect(await screen.findByText(/Open a PR when the plan completes/)).toBeTruthy();
  });

  it('the QA toggle appears only where the gate is off and writes are allowed', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null, qaMode: 'on' });
    await screen.findByText('Branch');
    expect(screen.queryByText(/Turn the QA gate on/)).toBeNull();

    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null, qaMode: 'off', allowWrites: false });
    const boxes = await screen.findAllByText(/Turn the QA gate on/);
    expect(boxes.length).toBe(1);
    const box = screen.getByRole('checkbox', { name: /Turn the QA gate on/ });
    expect(box).toBeDisabled();
    expect(box.getAttribute('title')).toMatch(/--allow-writes/);
  });

  it('the auto-recovery box needs --allow-agent, and follows the preference when it has it', async () => {
    // Without the flag: rendered, disabled, and the title names the flag.
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null });
    await screen.findByText('Branch');
    const off = screen.getByRole('checkbox', { name: /Auto-recover halts/ });
    expect(off).toBeDisabled();
    expect(off.getAttribute('title')).toMatch(/--allow-agent/);

    // With it: enabled and opening on the preference default (on).
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: null }, {}, { allowAgent: true });
    const boxes = await screen.findAllByRole('checkbox', { name: /Auto-recover halts/ });
    const on = boxes[boxes.length - 1]!;
    expect(on).not.toBeDisabled();
    expect((on as HTMLInputElement).checked).toBe(true);
  });

  it('opens on the Automation preferences, as the footer promises', async () => {
    await mount(
      { kind: 'phase', slug: 'alpha', phase: 3, run: null },
      { attachDefaultSkills: true, gitMode: 'new-branch', openPrOnComplete: false },
    );
    await screen.findByText('Branch');
    expect(screen.getByRole('button', { name: 'Attached' }).getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getAllByRole('combobox').find((el) => (el as HTMLSelectElement).value === 'new-branch'),
    ).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Open a PR/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('the submits', () => {
  it('a phase launch sends exactly what the dialog shows, scoped to its phase', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 3, run: RUN, qaMode: 'off', allowWrites: true });
    await screen.findByText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'Off' })); // attach defaults on
    fireEvent.click(screen.getByRole('checkbox', { name: /Turn the QA gate on/ })); // QA gate on
    fireEvent.click(screen.getByRole('button', { name: 'Run phase 3' }));
    await waitFor(() =>
      expect(runStart).toHaveBeenCalledWith('alpha', {
        model: 'sonnet',
        effort: 'high',
        // The dialog's deliberate default: switch to the account with headroom
        // at the usage wall, degrading to `wait` when there is only one login.
        onLimit: 'switch',
        autonomy: 'keep-going',
        phaseBudgetUsd: 5,
        runBudgetUsd: 40,
        permissionProfile: 'trusted',
        skills: ['design-review'],
        // Always sent as shown, like `autoRecover` below. `continue` is the
        // shipped default: an unreachable MCP server makes a phase report what it
        // could not do, rather than stopping the plan.
        mcpPolicy: 'continue',
        attachDefaultSkills: true,
        gitMode: 'default-branch',
        qa: true,
        // Always sent as shown: this console has no --allow-agent, so the box is
        // off and the run is written without the option — never silently.
        autoRecover: false,
        resumeRunId: 'run-1',
        onlyPhases: [3],
      }),
    );
  });

  it('a continue resumes the run and never narrows it', async () => {
    await mount({ kind: 'continue', slug: 'alpha', run: RUN });
    await screen.findByText('Branch');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(runStart).toHaveBeenCalled());
    const payload = runStart.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.resumeRunId).toBe('run-1');
    expect('onlyPhases' in payload).toBe(false);
  });

  it('a recovery submit merges the attached defaults into the skills it sends', async () => {
    await mount(
      { kind: 'recovery', recoveryClass: 'plan-repair', slug: 'alpha' },
      { attachDefaultSkills: true },
    );
    await screen.findByText('Model');
    fireEvent.click(screen.getByRole('button', { name: /Repair the plan with a new agent/ }));
    await waitFor(() => expect(agentTicket).toHaveBeenCalled());
    const body = agentTicket.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.intent).toBe('recovery');
    expect(body.recoveryClass).toBe('plan-repair');
    expect(body.skills).toEqual(['graph-tool']);
    expect('model' in body).toBe(false);
    expect('permissionProfile' in body).toBe(false);
  });
});

describe('a claimed phase', () => {
  const HELD = {
    owner: 'someone/else',
    expired: false,
    host: 'their-box',
    leaseUntil: Date.now() + 18 * 60_000,
    claimedAt: Date.now() - 12 * 60_000,
  };

  it('refuses to submit, and says who holds it', async () => {
    // The dialog agrees with the server rather than discovering the 409 after
    // the click. A dialog that submits into a refusal lied about its button.
    await mount({ kind: 'phase', slug: 'alpha', phase: 4, run: null, lock: HELD });

    await screen.findByText(/is claimed by/);
    expect(screen.getByText('someone/else')).toBeTruthy();
    expect(screen.getByText('their-box')).toBeTruthy();

    const submit = screen.getByRole('button', { name: /Run phase 4/ });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(runStart).not.toHaveBeenCalled();
  });

  it('a LAPSED claim warns but still launches', async () => {
    await mount({
      kind: 'phase',
      slug: 'alpha',
      phase: 4,
      run: null,
      lock: { ...HELD, expired: true },
    });

    await screen.findByText(/lapsed on this phase/);
    const submit = screen.getByRole('button', { name: /Run phase 4/ });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(runStart).toHaveBeenCalled());
  });

  it('an unclaimed phase shows no claim banner at all', async () => {
    await mount({ kind: 'phase', slug: 'alpha', phase: 4, run: null });
    await screen.findByText('Model');
    expect(screen.queryByText(/is claimed by/)).toBeNull();
    expect(screen.getByRole('button', { name: /Run phase 4/ }).hasAttribute('disabled')).toBe(false);
  });
});
