/**
 * The accounts card: meters always, registration only behind the flag.
 *
 * The card's one design rule is that a disabled capability explains itself —
 * a console without `--allow-accounts` still meters the machine login and
 * names the flag, because a card that hides when disabled looks like a bug.
 */

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { AccountsState } from '@/lib/api';

const { accountsMock } = vi.hoisted(() => ({
  accountsMock: vi.fn<() => Promise<AccountsState>>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, accounts: accountsMock, state: vi.fn(async () => ({})) } };
});
vi.mock('@/router', () => ({ navigate: vi.fn() }));

import { AccountsCard } from './accounts';

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AccountsCard />
    </QueryClientProvider>,
  );
}

const STATE: AccountsState = {
  allowAccounts: false,
  accounts: [
    {
      id: 'default',
      kind: 'default',
      builtIn: true,
      email: 'me@example.com',
      plan: 'max',
      usage: {
        buckets: {
          five_hour: { utilization: 42, resetsAt: '2026-08-06T20:00:00Z' },
          seven_day_fable: { utilization: 78, resetsAt: '2026-08-12T00:00:00Z' },
        },
        fetchedAt: '2026-08-06T10:00:00Z',
      },
    },
  ],
};

describe('the accounts card', () => {
  it('meters the machine login and explains the disabled registration', async () => {
    accountsMock.mockResolvedValue(STATE);
    mount();
    expect(await screen.findByText('me@example.com')).toBeTruthy();
    // Bucket keys render by NAME, so a window that ships tomorrow appears
    // tomorrow — including a per-model one nobody hard-coded.
    expect(screen.getByText('5-hour session')).toBeTruthy();
    expect(screen.getByText('Weekly (Fable)')).toBeTruthy();
    expect(screen.getByText(/--allow-accounts/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in…' })).toBeNull();
  });

  it('offers registration when the flag is on', async () => {
    accountsMock.mockResolvedValue({ ...STATE, allowAccounts: true });
    mount();
    expect(await screen.findByRole('button', { name: 'Sign in…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paste a token…' })).toBeTruthy();
  });
});
