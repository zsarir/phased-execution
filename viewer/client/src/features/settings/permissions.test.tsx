/**
 * The policy editor — deny parity, and the one confirm on the page.
 *
 * Since the 2026-08 reversal every list edits the same way: yours one-tap,
 * shipped defaults struck by name with ↩ and Restore-defaults as the ways
 * back. The single deliberate difference is pinned here: striking a SHIPPED
 * deny rule raises a dialog naming the exact rule, and the mutation fires only
 * on confirm — your own deny rules, and every ask/allow removal, stay one tap.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { editPolicy } = vi.hoisted(() => ({ editPolicy: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, editPolicy } };
});

const POLICY = {
  defaults: {
    deny: ['Bash(git push:*)', 'Bash(sudo:*)'],
    ask: ['Bash(git commit:*)'],
    allow: ['Bash(ls:*)'],
  },
  // `sudo` is struck (absent from effective, listed under removed); `task
  // nuke` is the operator's own deny rule.
  extra: {
    deny: ['Bash(task nuke:*)'],
    ask: [],
    allow: [],
    removed: { deny: ['Bash(sudo:*)'], ask: [], allow: [] },
  },
  plan: null,
  effective: {
    deny: ['Bash(git push:*)', 'Bash(task nuke:*)'],
    ask: ['Bash(git commit:*)'],
    allow: ['Bash(ls:*)'],
  },
  file: '/tmp/autopilot.json',
  profiles: [],
  inert: [],
  support: [],
  hookTools: ['Bash'],
  wrappersNotStripped: [],
  seen: [],
};

vi.mock('@/lib/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries')>();
  return {
    ...actual,
    usePolicy: () => ({ data: POLICY }),
    usePlans: () => ({ data: [] }),
  };
});

async function mount() {
  const client = new QueryClient(queryClientConfig);
  const { PolicyCard } = await import('./permissions');
  return render(
    <QueryClientProvider client={client}>
      <PolicyCard allowWrites />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  editPolicy.mockResolvedValue(POLICY);
});

describe('deny parity in the editor', () => {
  it('a shipped deny strike is confirmed by name, and lands only on confirm', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bash(git push:*)' }));

    // The dialog names the exact rule, and nothing has been written yet.
    expect(await screen.findByText('Remove a shipped deny rule?')).toBeTruthy();
    expect(editPolicy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove it' }));
    await waitFor(() =>
      expect(editPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'global', remove: { deny: ['Bash(git push:*)'] } }),
      ),
    );
  });

  it('cancelling the confirm writes nothing', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bash(git push:*)' }));
    await screen.findByText('Remove a shipped deny rule?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep the wall' }));
    expect(editPolicy).not.toHaveBeenCalled();
  });

  it('your own deny rule stays one tap — no dialog', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bash(task nuke:*)' }));
    expect(screen.queryByText('Remove a shipped deny rule?')).toBeNull();
    await waitFor(() =>
      expect(editPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ remove: { deny: ['Bash(task nuke:*)'] } }),
      ),
    );
  });

  it('a shipped ask removal stays one tap too', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bash(git commit:*)' }));
    expect(screen.queryByText('Remove a shipped deny rule?')).toBeNull();
    await waitFor(() =>
      expect(editPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ remove: { ask: ['Bash(git commit:*)'] } }),
      ),
    );
  });

  it('a struck deny rule renders with a way back, and ↩ restores it as a default', async () => {
    await mount();
    const restore = await screen.findByRole('button', { name: 'Restore Bash(sudo:*)' });
    fireEvent.click(restore);
    await waitFor(() =>
      expect(editPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ restore: { deny: ['Bash(sudo:*)'] } }),
      ),
    );
  });
});
