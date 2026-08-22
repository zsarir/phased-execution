/**
 * The one button on Settings that writes an executable.
 *
 * What is worth pinning is the *gating*, not the layout. This button mints a
 * 0755 file that starts a console with every capability on, so the three
 * states it can be in each have to be distinguishable and each refusal has to
 * name its own fix: writes disabled (restart with the flag), no source
 * directory open (open one — it is the ROOT that gets baked in), unsupported
 * platform (no button at all, the WSL story instead). A button that is merely
 * greyed out with no reason is the failure this card was written to avoid.
 *
 * The shown path is `~/…`, same privacy rule as the start-command card: a
 * screenshot of Settings must carry no username.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsoleState, LauncherPlanView } from '@/lib/api';

const { launcherPlan, createLauncher, stateMock } = vi.hoisted(() => ({
  launcherPlan: vi.fn<() => Promise<LauncherPlanView>>(),
  createLauncher: vi.fn<() => Promise<{ ok: true; path: string; note: string }>>(),
  stateMock: vi.fn<() => Promise<ConsoleState>>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, launcherPlan, createLauncher, state: stateMock } };
});

import { queryClientConfig } from '@/lib/queries';
import { LauncherCard } from './launcher';

const HOME = '/home/testperson';

const PLAN: LauncherPlanView = {
  platform: 'darwin',
  supported: true,
  kind: 'command',
  path: `${HOME}/Desktop/Phase Console.command`,
  note: 'Double-click it. The first run may install the launchd agent, which builds the client once.',
  rootOpen: true,
  fullFlags: [
    '--allow-writes',
    '--allow-run',
    '--allow-terminal',
    '--allow-agent',
    '--allow-accounts',
    '--allow-mcp',
  ],
};

const STATE: ConsoleState = {
  platform: 'darwin',
  home: HOME,
  port: 4123,
  root: { path: `${HOME}/code/my-repo`, ok: true },
  allowWrites: true,
};

function mount(supervised?: boolean) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <LauncherCard supervised={supervised} />
    </QueryClientProvider>,
  );
}

/** The button, by the label the guide and the README both name. */
function createButton() {
  return screen.getByRole('button', { name: /Create the Desktop launcher/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  launcherPlan.mockResolvedValue(PLAN);
  stateMock.mockResolvedValue(STATE);
  createLauncher.mockResolvedValue({ ok: true, path: PLAN.path!, note: PLAN.note });
});

describe('the button does what it says', () => {
  it('writes the launcher on click and reports where it landed', async () => {
    mount();
    const button = await screen.findByRole('button', { name: /Create the Desktop launcher/ });
    expect(button.hasAttribute('disabled')).toBe(false);

    fireEvent.click(button);

    await waitFor(() => expect(createLauncher).toHaveBeenCalledTimes(1));
    // The written path is the server's answer, not the plan's guess — they
    // agree here, but the card must render what actually happened.
    expect(await screen.findByText(PLAN.path!)).toBeTruthy();
  });

  it('names the flags it bakes in, so the click is not a blind one', async () => {
    mount();
    await screen.findByText('--allow-mcp');
    for (const flag of PLAN.fullFlags) expect(screen.getByText(flag)).toBeTruthy();
  });

  it('shows the destination as ~/… — a screenshot of Settings carries no username', async () => {
    mount();
    expect(await screen.findByText('~/Desktop/Phase Console.command')).toBeTruthy();
    expect(screen.queryByText(PLAN.path!)).toBeNull();
  });

  it('surfaces a refusal instead of claiming a file was written', async () => {
    createLauncher.mockRejectedValue(new Error('the launcher template has no LAUNCHER_REV'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Create the Desktop launcher/ }));

    await waitFor(() => expect(createLauncher).toHaveBeenCalled());
    expect(screen.queryByText(/Written to/)).toBeNull();
    // And the button comes back — a failed write must be retryable.
    await waitFor(() => expect(createButton().hasAttribute('disabled')).toBe(false));
  });
});

describe('every refusal names its own fix', () => {
  it('a read-only console disables the button and points at --allow-writes', async () => {
    stateMock.mockResolvedValue({ ...STATE, allowWrites: false });
    mount();
    await waitFor(() => expect(createButton().hasAttribute('disabled')).toBe(true));
    expect(createButton().getAttribute('title')).toMatch(/--allow-writes/);
  });

  it('no source directory open disables it and says the ROOT is what is missing', async () => {
    launcherPlan.mockResolvedValue({ ...PLAN, rootOpen: false });
    mount();
    await waitFor(() => expect(createButton().hasAttribute('disabled')).toBe(true));
    expect(createButton().getAttribute('title')).toMatch(/source directory/i);
  });

  it('an unsupported platform offers the WSL story, not a button that cannot work', async () => {
    launcherPlan.mockResolvedValue({
      platform: 'win32',
      supported: false,
      note: 'Phase Console runs on macOS and Linux. On Windows, install it inside WSL.',
      rootOpen: true,
      fullFlags: PLAN.fullFlags,
    });
    mount();
    expect(await screen.findByText(/inside WSL/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create the Desktop launcher/ })).toBeNull();
  });
});

describe('the launchd answer to an unsupervised console', () => {
  it('explains why Restart refuses when nothing supervises this console', async () => {
    mount(false);
    expect(await screen.findByText(/Nothing is supervising this console/)).toBeTruthy();
    expect(screen.getByText('SUPERVISED="yes"')).toBeTruthy();
  });

  it('stays quiet when the console is supervised', async () => {
    mount(true);
    await screen.findByRole('button', { name: /Create the Desktop launcher/ });
    expect(screen.queryByText(/Nothing is supervising/)).toBeNull();
  });
});
