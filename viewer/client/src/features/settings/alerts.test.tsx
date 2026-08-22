/**
 * The global notification switches.
 *
 * The properties worth asserting are the ones the old per-device card could not
 * hold: it renders and works with **no push device subscribed** (the console
 * that had nowhere to store a preference at all), it shows what the *server*
 * holds rather than a local copy, it sends a delta rather than the whole map
 * (so two tabs cannot overwrite each other), and it says something when the
 * operator silences a category that work stops dead behind.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, push, savePrefs } = vi.hoisted(() => ({
  state: vi.fn(),
  push: vi.fn(),
  savePrefs: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, push, savePrefs } };
});

/** The three categories the card treats as load-bearing, plus the firehose. */
const CATEGORIES = [
  {
    id: 'approval',
    label: 'Permission needed',
    detail: 'blocked on a decision',
    byDefault: true,
    urgent: true,
  },
  { id: 'halted', label: 'Run halted', detail: 'stopped on something', byDefault: true, urgent: true },
  { id: 'changed', label: 'Plans changed on disk', detail: 'a firehose', byDefault: false, urgent: false },
];

function mount(notify: Record<string, boolean> = {}) {
  state.mockResolvedValue({ prefs: { notify } });
  const client = new QueryClient(queryClientConfig);
  return import('./alerts').then(({ PreferencesCard }) =>
    render(
      <QueryClientProvider client={client}>
        <PreferencesCard />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The case the whole card exists for: nothing subscribed, nowhere for a
  // per-device preference to live.
  push.mockResolvedValue({ publicKey: '', devices: [], categories: CATEGORIES });
  savePrefs.mockResolvedValue({});
});

describe('global notification preferences', () => {
  it('renders every category with no device subscribed', async () => {
    await mount({ approval: true, halted: true, changed: false });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(screen.getByRole('checkbox', { name: 'Run halted' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Plans changed on disk' })).toBeTruthy();
  });

  it('shows what the server holds, not a local copy', async () => {
    await mount({ approval: true, halted: true, changed: false });
    const firehose = await screen.findByRole('checkbox', { name: 'Plans changed on disk' });
    expect((firehose as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Run halted' }) as HTMLInputElement).checked).toBe(true);
  });

  it('falls back to a category default the stored config has never seen', async () => {
    // `halted` absent from the map entirely — an older config, a new category.
    await mount({ approval: true });
    const halted = await screen.findByRole('checkbox', { name: 'Run halted' });
    expect((halted as HTMLInputElement).checked).toBe(true);
    // …and the firehose stays off by its own default rather than reading as on.
    expect(
      (screen.getByRole('checkbox', { name: 'Plans changed on disk' }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('sends only the category that changed, so two tabs cannot overwrite each other', async () => {
    await mount({ approval: true, halted: true, changed: false });
    const firehose = await screen.findByRole('checkbox', { name: 'Plans changed on disk' });
    fireEvent.click(firehose);
    // `mutate()` hands the call to react-query rather than making it inline.
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ notify: { changed: true } }));
  });

  it('warns when a category that stops work dead is silenced', async () => {
    await mount({ approval: false, halted: true, changed: false });
    expect(await screen.findByText(/Permission needed is off/)).toBeTruthy();
  });

  it('says nothing alarming when only the firehose is off', async () => {
    await mount({ approval: true, halted: true, changed: false });
    await screen.findByRole('checkbox', { name: 'Permission needed' });
    expect(screen.queryByText(/is off\./)).toBeNull();
    expect(screen.getByText('1 of 3 silenced')).toBeTruthy();
  });
});
