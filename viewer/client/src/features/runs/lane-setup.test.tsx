/**
 * The run-page account picker.
 *
 * The bug this pins: the old select listed the accounts MINUS the current one,
 * which on a two-account machine read as "the console only knows one account"
 * — the exact question the row exists to answer. Every account renders now,
 * the current one marked, and Switch only arms once a different one is picked.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { AccountsState, RunState } from '@/lib/api';

const { accountsMock } = vi.hoisted(() => ({
  accountsMock: vi.fn<() => Promise<AccountsState>>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      accounts: accountsMock,
      runSwitchAccount: vi.fn(async () => ({ ok: true })),
    },
  };
});

import { SwitchAccountRow } from '@/components/switch-account';

const RUN = { id: 'r1', slug: 'demo', status: 'running' } as unknown as RunState;

function mount(run: RunState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SwitchAccountRow slug="demo" run={run} disabled={false} />
    </QueryClientProvider>,
  );
}

describe('SwitchAccountRow', () => {
  it('lists EVERY account — the current one marked — and arms Switch only on a change', async () => {
    accountsMock.mockResolvedValue({
      allowAccounts: true,
      accounts: [
        { id: 'default', kind: 'default', builtIn: true, email: 'me@example.com' },
        { id: 'info', kind: 'profile', builtIn: false, name: 'info', email: 'info@example.com' },
      ],
    });
    mount(RUN);

    const select = await screen.findByRole('combobox', { name: 'Account for this run' });
    const labels = Array.from(select.querySelectorAll('option')).map((option) => option.textContent);
    expect(labels[0]).toMatch(/auto — most headroom/);
    expect(labels.some((label) => /machine login.*· current/.test(label ?? ''))).toBe(true);
    expect(labels.some((label) => /info.*info@example.com/.test(label ?? ''))).toBe(true);

    // The select shows where the run IS; Switch has nothing to do yet.
    const button = screen.getByRole('button', { name: 'Switch account' });
    expect(button).toBeDisabled();
    fireEvent.change(select, { target: { value: 'info' } });
    expect(button).not.toBeDisabled();
  });

  it('with one account it stays visible as awareness, pointing at Settings', async () => {
    accountsMock.mockResolvedValue({
      allowAccounts: true,
      accounts: [{ id: 'default', kind: 'default', builtIn: true, email: 'me@example.com' }],
    });
    mount(RUN);
    expect(await screen.findByText(/Add another account in Settings/)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
