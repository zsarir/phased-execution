/**
 * The session-presence hook card — what it says, what it offers, what it refuses.
 *
 * Pinned: the status word for each registry answer; Install calls the API and
 * the card re-reads the returned status; Remove shows only when installed and
 * pointing at this checkout; every disabled state names its fix (writes off, a
 * settings file that does not parse); the path renders as `~/…`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, HooksStatusView, HooksWriteView } from '@/lib/api';

const { hooksStatus, hooksInstall, stateMock } = vi.hoisted(() => ({
  hooksStatus: vi.fn<() => Promise<HooksStatusView>>(),
  hooksInstall: vi.fn<(action: 'install' | 'uninstall') => Promise<HooksWriteView>>(),
  stateMock: vi.fn<() => Promise<ConsoleState>>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, hooksStatus, hooksInstall, state: stateMock } };
});

import { SessionHookCard } from './hooks';
import { queryClientConfig } from '@/lib/queries';

const HOME = '/home/sam';
const NOT_INSTALLED: HooksStatusView = {
  path: `${HOME}/.claude/settings.json`,
  exists: true,
  installed: false,
  partial: false,
  events: { SessionStart: false, SessionEnd: false, Stop: false },
  command: 'bash "/opt/skill/scripts/session-hook.sh"',
  stale: false,
};
const INSTALLED: HooksStatusView = {
  ...NOT_INSTALLED,
  installed: true,
  events: { SessionStart: true, SessionEnd: true, Stop: true },
};

function state(over: Partial<ConsoleState> = {}): ConsoleState {
  return { allowWrites: true, home: HOME, ...over } as ConsoleState;
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <SessionHookCard />
    </QueryClientProvider>,
  );
}

describe('SessionHookCard', () => {
  beforeEach(() => {
    hooksStatus.mockReset();
    hooksInstall.mockReset();
    stateMock.mockReset();
    stateMock.mockResolvedValue(state());
  });

  it('says "not installed", offers Install, and re-reads the status the write returns', async () => {
    hooksStatus.mockResolvedValue(NOT_INSTALLED);
    hooksInstall.mockResolvedValue({ ok: true, path: NOT_INSTALLED.path, changed: true, status: INSTALLED });
    mount();
    await waitFor(() => expect(screen.getByTestId('hook-status')).toHaveTextContent('not installed'));
    expect(await screen.findByText('~/.claude/settings.json')).toBeTruthy();
    const button = await screen.findByRole('button', { name: /install the hook/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(hooksInstall).toHaveBeenCalledWith('install'));
    await waitFor(() => expect(screen.getByTestId('hook-status')).toHaveTextContent('installed'));
    expect(await screen.findByRole('button', { name: /remove the hook/i })).toBeTruthy();
  });

  it('installed: offers Remove, which calls uninstall and shows not installed again', async () => {
    hooksStatus.mockResolvedValue(INSTALLED);
    hooksInstall.mockResolvedValue({ ok: true, path: INSTALLED.path, changed: true, status: NOT_INSTALLED });
    mount();
    await waitFor(() => expect(screen.getByTestId('hook-status')).toHaveTextContent('installed'));
    fireEvent.click(await screen.findByRole('button', { name: /remove the hook/i }));
    await waitFor(() => expect(hooksInstall).toHaveBeenCalledWith('uninstall'));
    await waitFor(() => expect(screen.getByTestId('hook-status')).toHaveTextContent('not installed'));
  });

  it('a stale or partial install reads as such and the button says Repair', async () => {
    hooksStatus.mockResolvedValue({ ...INSTALLED, installed: false, partial: true, stale: true });
    mount();
    await waitFor(() =>
      expect(screen.getByTestId('hook-status')).toHaveTextContent('points at another checkout'),
    );
    expect(await screen.findByRole('button', { name: /repair the hook/i })).toBeTruthy();
  });

  it('writes off: the button is disabled and its title names the flag', async () => {
    hooksStatus.mockResolvedValue(NOT_INSTALLED);
    stateMock.mockResolvedValue(state({ allowWrites: false }));
    mount();
    const button = await screen.findByRole('button', { name: /install the hook/i });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(button.getAttribute('title')).toMatch(/--allow-writes/);
  });

  it('a settings file that does not parse disables Install and says why', async () => {
    hooksStatus.mockResolvedValue({ ...NOT_INSTALLED, parseError: 'Unexpected token' });
    mount();
    await waitFor(() => expect(screen.getByTestId('hook-status')).toHaveTextContent('does not parse'));
    const button = await screen.findByRole('button', { name: /install the hook/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText(/will not write to a settings file it cannot read/)).toBeTruthy();
  });
});
