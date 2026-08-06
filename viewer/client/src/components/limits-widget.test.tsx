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
import { LimitsOverview } from './limits-widget';

const savePrefs = vi.fn(async (_patch: Record<string, unknown>) => ({}));
let notify: Record<string, boolean> = {};

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state: vi.fn(async () => ({ prefs: { notify } })),
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
    expect(await screen.findByText(/Runs still wait, switch account or pause as you asked/i))
      .toBeTruthy();
    expect(screen.getByText(/meters above keep updating/i)).toBeTruthy();
  });
});
