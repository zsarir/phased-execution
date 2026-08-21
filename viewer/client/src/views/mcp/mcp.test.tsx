/**
 * The MCP page: what it says with the flag off, what it warns about, and that
 * the destructive verb states its cost before it happens.
 *
 * Asserted through roles and copy rather than implementation, like every other
 * view test here — the point is that an operator can read the page and act on
 * it, not that a particular div exists.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { McpServerView, McpState } from '@/lib/api';

const { mcpMock, catalogMock, deleteMock, patchMock } = vi.hoisted(() => ({
  mcpMock: vi.fn<() => Promise<McpState>>(),
  catalogMock: vi.fn(),
  deleteMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      mcp: mcpMock,
      mcpCatalog: catalogMock,
      mcpDelete: deleteMock,
      mcpPatch: patchMock,
      mcpRefresh: vi.fn(async () => ({ servers: [] })),
      state: vi.fn(async () => ({})),
    },
  };
});
vi.mock('@/app/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/router')>()),
  navigate: vi.fn(),
}));

import McpView from './index';

function server(patch: Partial<McpServerView> = {}): McpServerView {
  return {
    id: 'ctx7',
    label: 'Context7',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    enabled: true,
    auth: { kind: 'none', secrets: [] },
    status: 'connected',
    ...patch,
  };
}

function mount() {
  const route = { segments: ['mcp'], query: {}, path: '/mcp' };
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <McpView route={route} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  catalogMock.mockResolvedValue({ entries: [] });
});

describe('the MCP page', () => {
  it('names the flag when registration is off, and offers no verbs', async () => {
    mcpMock.mockResolvedValue({ servers: [server()], allowMcp: false });
    mount();

    // The card still renders — a capability that hides when disabled looks like
    // a bug — and the off-state says which flag would change it.
    expect(await screen.findByText('Context7')).toBeTruthy();
    expect(screen.getByText(/--allow-mcp/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Switch off' })).toBeNull();
  });

  it('warns at the top when a server needs a person, in the words a park uses', async () => {
    mcpMock.mockResolvedValue({
      servers: [server({ id: 'gh', label: 'GitHub', status: 'needs-auth' })],
      allowMcp: true,
    });
    mount();

    expect(await screen.findByText(/GitHub needs attention/)).toBeTruthy();
    expect(screen.getByText(/park at boarding/)).toBeTruthy();
    expect(screen.getByText('needs sign-in')).toBeTruthy();
  });

  it('treats pending as normal rather than as an alarm', async () => {
    // A remote server with a cached tool list reports pending and connects on
    // first use. Flagging it would train people to ignore the flag.
    mcpMock.mockResolvedValue({ servers: [server({ status: 'pending' })], allowMcp: true });
    mount();

    expect(await screen.findByText('connects on first use')).toBeTruthy();
    expect(screen.queryByText(/needs attention/)).toBeNull();
  });

  it('surfaces a tool-list change as the supply-chain event it is', async () => {
    mcpMock.mockResolvedValue({
      servers: [
        server({
          toolsChanged: { added: ['exfiltrate'], removed: [], seenAt: new Date().toISOString() },
        }),
      ],
      allowMcp: true,
    });
    mount();

    expect(await screen.findByText(/advertises different tools/)).toBeTruthy();
    expect(screen.getByText(/Added: exfiltrate/)).toBeTruthy();
    expect(screen.getByText(/trusted integration becomes an untrusted one/)).toBeTruthy();
  });

  it('warns that an interactive tool can never be approved unattended', async () => {
    mcpMock.mockResolvedValue({
      servers: [server({ interactiveTools: ['grant_access'] })],
      allowMcp: true,
    });
    mount();

    expect(await screen.findByText(/grant_access/)).toBeTruthy();
    expect(screen.getByText(/will stall rather than finish/)).toBeTruthy();
  });

  it('states what removal costs before it happens', async () => {
    mcpMock.mockResolvedValue({ servers: [server()], allowMcp: true });
    deleteMock.mockResolvedValue({ removed: true });
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    // The dialog is the confirmation: the cost is stated, and nothing has happened.
    expect(await screen.findByText(/keychain entries/)).toBeTruthy();
    expect(screen.getByText(/will park at boarding/)).toBeTruthy();
    expect(deleteMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove server' }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('ctx7'));
  });

  it('says plainly that a run with too many servers is paying for them', async () => {
    mcpMock.mockResolvedValue({
      servers: Array.from({ length: 7 }, (_, i) => server({ id: `s${i}`, label: `S${i}` })),
      allowMcp: true,
    });
    mount();

    expect(await screen.findByText(/7 servers are switched on/)).toBeTruthy();
    expect(screen.getByText(/three to six is the range/)).toBeTruthy();
  });

  it('explains itself with an empty registry rather than showing a blank page', async () => {
    mcpMock.mockResolvedValue({ servers: [], allowMcp: true });
    mount();

    expect(await screen.findByText('No MCP servers registered')).toBeTruthy();
    expect(screen.getByText(/whatever MCP configuration this machine already has/)).toBeTruthy();
  });
});
