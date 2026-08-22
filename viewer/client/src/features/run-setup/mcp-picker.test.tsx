/**
 * The MCP picker, where "I have not checked" must not read as "this works".
 *
 * This control's own header says it exists so that a server which cannot be
 * attached is found HERE rather than at boarding, after the queue and the lock.
 * It got that wrong through the one status it did not test for: a server nobody
 * has probed reports `unknown`, and `usable()` only refused `needs-auth` and
 * `failed` — so an operator ticking six servers in the launch dialog saw six
 * ordinary rows, and three of them turned out to be walls three and a half
 * minutes later, with a whole plan behind them.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpPicker } from './mcp-picker';
import type { McpServerView } from '@/lib/api';

function server(over: Partial<McpServerView> & { id: string }): McpServerView {
  return {
    label: over.id,
    transport: 'http',
    enabled: true,
    auth: { kind: 'oauth', secrets: [] },
    status: 'connected',
    ...over,
  } as McpServerView;
}

function mount(servers: McpServerView[], props: Record<string, unknown> = {}) {
  return render(<McpPicker servers={servers} chosen={[]} onChange={vi.fn()} {...props} />);
}

const box = (id: string) => screen.getByRole('checkbox', { name: new RegExp(id) }) as HTMLInputElement;

describe('the MCP picker', () => {
  it('a server nobody has probed is tickable, but never reads as verified', async () => {
    mount([server({ id: 'ctx7', status: 'unknown' })]);
    fireOpen();
    // Tickable — `unknown` genuinely might work, and refusing it would make a
    // freshly-added server unusable until somebody remembered to probe it.
    expect(box('ctx7').disabled).toBe(false);
    // But it says so, which is the part that was missing.
    expect(screen.getByText('not checked yet')).toBeTruthy();
    expect(screen.getByText(/status simply is not known yet/)).toBeTruthy();
  });

  it('a connected server says nothing about being unchecked', async () => {
    mount([server({ id: 'ctx7', status: 'connected', toolCount: 2 })]);
    fireOpen();
    expect(screen.queryByText('not checked yet')).toBeNull();
    expect(box('ctx7').disabled).toBe(false);
  });

  it('a registration nobody finished is refused, and names the variable', async () => {
    // The catalog's filesystem entry ships as `… ${MCP_FS_ROOT}` with an
    // authNote asking for a value. Nothing collected one, so it probes `failed`
    // forever — and it was ticked onto a real run and blocked three phases.
    mount([
      server({
        id: 'fs',
        transport: 'stdio',
        status: 'unknown',
        needsConfig: ['MCP_FS_ROOT'],
      }),
    ]);
    fireOpen();
    expect(box('fs').disabled).toBe(true);
    expect(screen.getByText('needs MCP_FS_ROOT')).toBeTruthy();
    // And it is not offered as a merely-unchecked server either: it will not
    // connect however many times it is probed.
    expect(screen.queryByText('not checked yet')).toBeNull();
  });

  it('the walls it always refused are still refused', async () => {
    mount([
      server({ id: 'gh', status: 'needs-auth' }),
      server({ id: 'off', status: 'connected', enabled: false }),
    ]);
    fireOpen();
    expect(box('gh').disabled).toBe(true);
    expect(screen.getByText('needs signing in')).toBeTruthy();
    expect(box('off').disabled).toBe(true);
    expect(screen.getByText('switched off')).toBeTruthy();
  });
});

/** The list lives inside a `<details>`, closed until somebody is choosing. */
function fireOpen(): void {
  const details = document.querySelector('details');
  if (details) details.open = true;
}
