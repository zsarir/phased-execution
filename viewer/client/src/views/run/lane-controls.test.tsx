/**
 * Per-session Freeze / Continue / Stop.
 *
 * Three properties: a destructive Stop never fires without its dialog, and
 * the dialog promises the one thing that distinguishes this verb from the
 * run-level Stop — the rest of the run carries on; a queued lane offers only
 * the dequeue-stop (there is no process to freeze); and without `--allow-run`
 * the controls are disabled with the reason in reach, never hidden.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { RunState } from '@/lib/api';

const { stopMock, freezeMock, thawMock } = vi.hoisted(() => ({
  stopMock: vi.fn(async () => ({ run: null })),
  freezeMock: vi.fn(async () => ({ run: null })),
  thawMock: vi.fn(async () => ({ run: null })),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, runStop: stopMock, runFreeze: freezeMock, runThaw: thawMock },
  };
});

import { LaneControls, laneFrozen } from './lane-controls';

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('LaneControls', () => {
  it('stops one lane only after the dialog, which promises the run carries on', async () => {
    mount(<LaneControls slug="demo" phase={9} live allowRun frozen={null} />);
    expect(stopMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText(/the other lanes keep working/i)).toBeTruthy();
    expect(screen.getByText(/interrupted/)).toBeTruthy();
    expect(stopMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop this phase' }));
    await waitFor(() => expect(stopMock).toHaveBeenCalledWith('demo', 9));
  });

  it('offers Freeze for a live lane, Continue for a frozen one', () => {
    const { unmount } = mount(<LaneControls slug="demo" phase={9} live allowRun frozen={null} />);
    expect(screen.getByRole('button', { name: 'Freeze' })).toBeTruthy();
    unmount();

    mount(
      <LaneControls
        slug="demo" phase={9} live allowRun
        frozen={{ at: '2026-08-06T10:00:00Z', by: 'me', escalateAt: '2026-08-06T10:15:00Z' }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('a queued lane gets the dequeue-stop and nothing to freeze', async () => {
    mount(<LaneControls slug="demo" phase={7} live allowRun frozen={null} queued />);
    expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText(/out of the admission line/i)).toBeTruthy();
  });

  it('without --allow-run the controls are disabled with the reason, never hidden', () => {
    mount(<LaneControls slug="demo" phase={9} live allowRun={false} frozen={null} />);
    const freeze = screen.getByRole('button', { name: 'Freeze' });
    expect(freeze).toBeDisabled();
    expect(freeze.getAttribute('title')).toMatch(/--allow-run/);
  });
});

describe('laneFrozen', () => {
  const base = { id: 'r1', slug: 'demo' } as unknown as RunState;
  const ref = { at: 'a', by: 'b', escalateAt: 'c' };

  it('prefers the per-lane record, falls back to the single slot, and never cross-reads', () => {
    expect(laneFrozen({
      ...base,
      children: { 9: { pid: 1, phase: 9, sessionId: '', startedAt: '', frozen: ref } },
    } as RunState, 9)).toEqual(ref);

    expect(laneFrozen({
      ...base,
      freeze: { at: 'a', phase: 9, pid: 1, by: 'b', escalateAt: 'c' },
    } as RunState, 9)).toEqual(ref);

    expect(laneFrozen({
      ...base,
      freeze: { at: 'a', phase: 7, pid: 1, by: 'b', escalateAt: 'c' },
    } as RunState, 9)).toBeNull();
  });
});
