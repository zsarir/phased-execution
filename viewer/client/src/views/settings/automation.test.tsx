/**
 * The automation defaults card.
 *
 * What matters here mirrors the notifications card next to it: the card
 * renders the SERVER's values with the documented fallbacks (a config from
 * before the keys existed must read skills-off, QA-off, current-branch,
 * PR-on, guard-on), each toggle sends exactly its own key as a delta, and the
 * PR row exists only where it means anything — under the work-branch mode.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, savePrefs } = vi.hoisted(() => ({ state: vi.fn(), savePrefs: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, savePrefs } };
});

function mount(prefs: Record<string, unknown> = {}, defaultSkills: string[] = ['graph-tool']) {
  state.mockResolvedValue({ prefs, defaultSkills });
  const client = new QueryClient(queryClientConfig);
  return import('./automation').then(({ AutomationCard }) => render(
    <QueryClientProvider client={client}><AutomationCard /></QueryClientProvider>,
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  savePrefs.mockResolvedValue({});
});

describe('the automation defaults card', () => {
  it('a config from before the keys existed reads as the documented defaults', async () => {
    await mount({});
    // Skills and QA open Off; the guard and the two recovery-automation knobs
    // open On; the PR row is hidden under the default branch mode, so exactly
    // five toggles render.
    const off = await screen.findAllByRole('button', { name: 'Off' });
    expect(off.length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'On' }).length).toBe(3);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('default-branch');
  });

  it('lists the machine default skills as data, never as copy', async () => {
    await mount({}, ['graph-tool', 'indexer']);
    expect(await screen.findByText('graph-tool')).toBeTruthy();
    expect(screen.getByText('indexer')).toBeTruthy();
  });

  it('each toggle sends exactly its own key', async () => {
    await mount({});
    const rows = await screen.findByText('Repository guard');
    expect(rows).toBeTruthy();
    const guard = screen.getAllByRole('button', { pressed: true });
    fireEvent.click(guard[guard.length - 1]!);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ repoGuard: false }));
  });

  it('the PR row appears only under the work-branch mode', async () => {
    await mount({});
    await screen.findByRole('combobox');
    expect(screen.queryByText('Open a PR when the plan completes')).toBeNull();
    expect(screen.getByText(/applies to work-branch runs/)).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new-branch' } });
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ gitMode: 'new-branch' }));
  });

  it('renders the stored choices, not the defaults, when the server has them', async () => {
    await mount({ gitMode: 'new-branch', repoGuard: false, attachDefaultSkills: true });
    await screen.findByRole('combobox');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('new-branch');
    expect(await screen.findByText('Open a PR when the plan completes')).toBeTruthy();
  });
});
