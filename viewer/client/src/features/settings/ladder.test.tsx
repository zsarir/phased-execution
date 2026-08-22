/**
 * The ladder card: twelve server preferences rendered from `/api/state` and
 * saved one key per change through `/api/prefs` — the caps in rungs AND
 * dollars, the two clocks in minutes, the one budget raise, the four toggles.
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

async function mount(prefs: Record<string, unknown> = {}) {
  state.mockResolvedValue({ root: { ok: true, path: '/repo' }, autopilot: true, prefs });
  savePrefs.mockResolvedValue({});
  const { LadderCard } = await import('./ladder');
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <LadderCard />
    </QueryClientProvider>,
  );
  await screen.findByText('Automation · the ladder');
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  state.mockReset();
  savePrefs.mockReset();
});

describe('<LadderCard>', () => {
  it('reads a config from before the keys existed as the shipped defaults', async () => {
    await mount({});
    expect(field('Rungs per phase').value).toBe('3');
    expect(field('Spend per phase').value).toBe('100');
    expect(field('Rungs per run').value).toBe('10');
    expect(field('Spend per run').value).toBe('400');
    expect(field('Spend per day').value).toBe('600');
    // The clocks in minutes, never milliseconds.
    expect(field('Sweep every').value).toBe('5');
    expect(field('Park on a required MCP server for').value).toBe('30');
    expect(field('Raise a spent run budget once by').value).toBe('25');
    // The four toggles default on — the design's "all default on".
    expect(screen.getAllByRole('button', { name: 'On' })).toHaveLength(4);
    expect(screen.queryAllByRole('button', { name: 'Off' })).toHaveLength(0);
  });

  it('renders the stored choices, not the defaults', async () => {
    await mount({ ladderPerDayUsd: 900, convergeEveryMs: 0, resumeAtBoot: false, mcpRequireTimeoutMs: 0 });
    expect(field('Spend per day').value).toBe('900');
    expect(field('Sweep every').value).toBe('0');
    expect(field('Park on a required MCP server for').value).toBe('0');
    expect(screen.getAllByRole('button', { name: 'Off' })).toHaveLength(1);
  });

  it('saves a cap as its own key when the field is left', async () => {
    await mount({});
    const input = field('Spend per phase');
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ ladderPerPhaseUsd: 150 }));
  });

  it('saves the sweep interval in milliseconds from a field in minutes', async () => {
    await mount({});
    const input = field('Sweep every');
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ convergeEveryMs: 120_000 }));
  });

  it('saves nothing for an unchanged or unusable value', async () => {
    await mount({});
    const input = field('Rungs per run');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '-4' } });
    fireEvent.blur(input);
    expect(savePrefs).not.toHaveBeenCalled();
    // The field snaps back to what the process holds.
    expect(input.value).toBe('10');
  });

  it('flips a toggle as its own key', async () => {
    await mount({});
    const [, , resume] = screen.getAllByRole('button', { name: 'On' });
    fireEvent.click(resume);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ resumeAtBoot: false }));
  });
});
