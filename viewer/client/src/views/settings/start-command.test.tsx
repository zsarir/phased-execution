/**
 * The start-command card: portable, per-OS, and free of the operator's name.
 *
 * The pinned properties: the composed line renders every path under the
 * server's home as `"$HOME/…"` — an absolute home path in the card is the
 * privacy leak this test exists to catch — and the card states the
 * Windows answer (WSL) instead of pretending a cmd.exe form exists.
 */

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { ConsoleState } from '@/lib/api';

const { stateMock } = vi.hoisted(() => ({ stateMock: vi.fn<() => Promise<ConsoleState>>() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state: stateMock } };
});

import { StartCommandCard, composeStartCommand, portablePath } from './start-command';

const STATE: ConsoleState = {
  platform: 'darwin',
  home: '/home/testperson',
  port: 4123,
  scriptsDir: '/home/testperson/.claude/skills/phased-execution/scripts',
  root: { path: '/home/testperson/code/my-repo', ok: true },
  allowWrites: true,
  allowRun: true,
  allowTerminal: false,
  allowAgent: false,
  allowAccounts: false,
};

describe('composeStartCommand', () => {
  it('renders every home path as "$HOME/…" and carries all five switches', () => {
    const command = composeStartCommand(STATE);
    expect(command).toBe(
      '"$HOME/.claude/skills/phased-execution/start" "$HOME/code/my-repo" --port 4123 '
      + '--allow-writes --allow-run --allow-terminal --allow-agent --allow-accounts',
    );
    expect(command).not.toContain('/home/testperson');
  });

  it('leaves a root outside home absolute, and degrades with no server facts', () => {
    expect(composeStartCommand({ ...STATE, root: { path: '/srv/repo' } })).toContain(' /srv/repo ');
    expect(composeStartCommand({})).toBe(
      'phase-console start --allow-writes --allow-run --allow-terminal --allow-agent --allow-accounts',
    );
  });

  it('carries every setting the console was started with — remote, ceiling, skills', () => {
    const command = composeStartCommand({
      ...STATE,
      remoteHosts: ['console.tail1234.ts.net'],
      remoteUsers: ['op@github'],
      concurrency: { max: 5 },
      defaultSkills: ['qa', 'design-review'],
    });
    expect(command).toContain('--remote console.tail1234.ts.net');
    expect(command).toContain('--remote-user op@github');
    expect(command).toContain('--max-sessions 5');
    expect(command).toContain('--default-skills qa,design-review');
    // The default ceiling stays unspoken — a plain console composes the plain line.
    expect(composeStartCommand({ ...STATE, concurrency: { max: 3 } })).not.toContain('--max-sessions');
  });
});

describe('portablePath', () => {
  it('double-quotes so $HOME still expands, and quotes awkward paths', () => {
    expect(portablePath('/home/a/code', '/home/a')).toBe('"$HOME/code"');
    expect(portablePath('/home/a', '/home/a')).toBe('"$HOME"');
    expect(portablePath('/tmp/plain', undefined)).toBe('/tmp/plain');
    expect(portablePath('/tmp/with space', undefined)).toBe("'/tmp/with space'");
  });
});

describe('the card', () => {
  it('shows the portable command, the OS it is for, and the WSL answer for Windows', async () => {
    stateMock.mockResolvedValue(STATE);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <StartCommandCard />
      </QueryClientProvider>,
    );
    // Anchor on text that exists only once the query has resolved — the
    // pre renders immediately with the degraded fallback command.
    const pre = await screen.findByText(/my-repo/, { selector: 'pre' });
    expect(pre.textContent).toContain('"$HOME/code/my-repo"');
    expect(pre.textContent).toContain('--allow-accounts');
    expect(pre.textContent).not.toContain('/home/testperson');
    expect(screen.getByText(/macOS — run it in a terminal/)).toBeTruthy();
    expect(screen.getByText(/Windows:/)).toBeTruthy();
    expect(screen.getByText(/WSL shell/)).toBeTruthy();
    // The running console lacks three switches; the card names them.
    expect(screen.getByText('terminal')).toBeTruthy();
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('accounts')).toBeTruthy();
  });
});
