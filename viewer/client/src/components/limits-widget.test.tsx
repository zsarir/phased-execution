/**
 * The usage-alert mute.
 *
 * The property worth pinning is that this control and the one on
 * Notifications ▸ Settings are the SAME preference, not two that agree by
 * habit. It renders from `/api/state` and writes the same `notify.limits`
 * delta, so a second switch cannot drift out of step with the first.
 *
 * The other property is the copy: turning this off also silences a run that
 * parked waiting for a window and an account that could not sign in, and a
 * console that goes quiet about those looks exactly like one that has stopped
 * working. The warning is part of the control, not a footnote elsewhere.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClientConfig } from '@/lib/queries';
import { LimitsOverview, LimitsWidget } from './limits-widget';

const savePrefs = vi.fn(async (_patch: Record<string, unknown>) => ({}));
let notify: Record<string, boolean> = {};
let registered: unknown[] = [];

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state: vi.fn(async () => ({ prefs: { notify } })),
      accounts: vi.fn(async () => ({ accounts: registered, allowAccounts: true })),
      savePrefs: (patch: Record<string, unknown>) => savePrefs(patch),
    },
  };
});

function renderOverview(accounts?: Parameters<typeof LimitsOverview>[0]['accounts']) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <LimitsOverview accounts={accounts} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  savePrefs.mockClear();
  notify = {};
  registered = [];
});

/**
 * The chrome answers for EVERY account and EVERY window.
 *
 * It used to render one number — the worst 5-hour figure anywhere — which
 * cannot say which login is near its wall, nor that the other one is empty,
 * nor that a weekly window is the real constraint. On a machine with two
 * accounts that is the difference between "stop working" and "switch account".
 */
describe('two entries, one identity', () => {
  it('says so — the pair looks like failover and is not', async () => {
    // The ordinary way to reach this: sign the machine's own `claude` login in
    // as the account you also registered as a profile. Each entry reads
    // correctly alone; only together are they a trap.
    renderOverview([
      { id: 'default', kind: 'default', builtIn: true, name: 'default', email: 'one@example.com' },
      { id: 'info', kind: 'profile', builtIn: false, name: 'info', email: 'One@Example.com' },
    ] as never);
    expect(await screen.findByText(/are the same Claude account/)).toBeTruthy();
    expect(screen.getByText('default and info')).toBeTruthy();
  });

  it('stays quiet when the logins genuinely differ', async () => {
    renderOverview([
      { id: 'default', kind: 'default', builtIn: true, name: 'default', email: 'one@example.com' },
      { id: 'work', kind: 'profile', builtIn: false, name: 'work', email: 'two@example.com' },
    ] as never);
    await screen.findByText(/Polled on a budget/);
    expect(screen.queryByText(/are the same Claude account/)).toBeNull();
  });
});

describe('the usage indicator', () => {
  const account = (id: string, buckets: Record<string, number>) => ({
    id,
    kind: id === 'default' ? 'default' : 'profile',
    builtIn: id === 'default',
    name: id,
    usage: {
      buckets: Object.fromEntries(
        Object.entries(buckets).map(([key, utilization]) => [key, { utilization, resetsAt: null }]),
      ),
    },
  });

  it('draws a bar per window for every account, per-model windows included', async () => {
    registered = [
      account('default', { five_hour: 94, seven_day: 52 }),
      account('info', { five_hour: 0, seven_day: 65, seven_day_fable: 30 }),
    ];
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <LimitsWidget variant="header" />
      </QueryClientProvider>,
    );
    // One labelled group per account, naming each window it reports — so a
    // window that ships tomorrow is drawn tomorrow, by key.
    expect(await screen.findByLabelText('default: 5-hour session 94%, Weekly (all models) 52%')).toBeTruthy();
    expect(
      await screen.findByLabelText('info: 5-hour session 0%, Weekly (all models) 65%, Weekly (Fable) 30%'),
    ).toBeTruthy();
  });

  it('an account reporting nothing draws nothing, and does not hide the others', async () => {
    registered = [account('default', {}), account('info', { five_hour: 12 })];
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <LimitsWidget variant="header" />
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText('info: 5-hour session 12%')).toBeTruthy();
    expect(screen.queryByLabelText(/^default:/)).toBeNull();
  });
});

describe('usage alerts', () => {
  it('offers the mute even when there is nothing to meter', async () => {
    // A console with no registered account still runs work as the default one,
    // and still announces when that hits a window.
    renderOverview([]);
    expect(await screen.findByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('writes the same notify.limits delta the notifications page writes', async () => {
    renderOverview([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => {
      expect(savePrefs).toHaveBeenCalledWith({ notify: { limits: false } });
    });
  });

  it('reads its state from the server, not from a local copy', async () => {
    notify = { limits: false };
    renderOverview([]);
    const button = await screen.findByRole('button', { name: 'Turn on' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('says what goes quiet with it, not just that something does', async () => {
    notify = { limits: false };
    renderOverview([]);
    // The three that are easy to miss: a parked run, a failed sign-in, and the
    // fact that the meters keep working.
    expect(await screen.findByText(/Runs still wait, switch account or pause as you asked/i)).toBeTruthy();
    expect(screen.getByText(/meters above keep updating/i)).toBeTruthy();
  });
});

describe('the compact meters read the worst account', () => {
  it('shows every account honestly in the overview, auth state included', async () => {
    renderOverview([
      {
        id: 'default',
        kind: 'default',
        builtIn: true,
        email: 'main@example.com',
        authState: 'ok',
        usage: {
          buckets: { five_hour: { utilization: 12, resetsAt: '2026-08-06T20:00:00Z' } },
          fetchedAt: '2026-08-06T15:00:00Z',
        },
      },
      {
        id: 'info',
        kind: 'profile',
        builtIn: false,
        name: 'info',
        email: 'info@example.com',
        signedIn: true,
        authState: 'expired',
        usage: {
          buckets: { seven_day_fable: { utilization: 82, resetsAt: '2026-08-12T00:00:00Z' } },
          fetchedAt: '2026-08-06T15:00:00Z',
        },
      },
    ]);
    // A broken login is a badge beside the account, where the meters are.
    expect(await screen.findByText('login expired')).toBeTruthy();
    // A per-model bucket renders by its key — Fable's window the day it ships.
    expect(screen.getByText('Weekly (Fable)')).toBeTruthy();
    expect(screen.getByText('info')).toBeTruthy();
  });
});
