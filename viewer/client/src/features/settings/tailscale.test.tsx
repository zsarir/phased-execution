/**
 * The card that turns a loopback console into a phone-reachable one.
 *
 * What is worth pinning here is not the layout — it is the *diagnosis*. This
 * feature is two settings in two different systems agreeing with each other,
 * and both halves look correct from the machine you are sitting at. So the
 * cases below are mostly the disagreements: served-but-not-flagged (every
 * request 421s), flagged-but-not-served (the URL never resolves), and the two
 * naming different hosts. Each has to be named, because each reads on the phone
 * as "the console is broken" and none of them is.
 *
 * Every hostname here is invented — `alpha`, `example.ts.net`. Writing the real
 * ones down in order to assert about them would be the leak the scrub hunts.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import type { TailscaleStatus } from '@/lib/api';
import { TailscaleCard } from './tailscale';

// `vi.hoisted`, because the mock factory is lifted above every top-level const.
const { tailscale } = vi.hoisted(() => ({ tailscale: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, tailscale } };
});

const SELF = {
  hostName: 'alpha',
  dnsName: 'alpha.example.ts.net',
  ips: ['100.64.0.1'],
  os: 'macOS',
  online: true,
};

const PEERS = [
  { hostName: 'beta', dnsName: 'beta.example.ts.net', ips: ['100.64.0.2'], os: 'iOS', online: true },
  {
    hostName: 'gamma',
    dnsName: 'gamma.example.ts.net',
    ips: ['100.64.0.3'],
    os: 'windows',
    online: false,
    lastSeen: '2026-06-01T10:00:00Z',
  },
];

/** The `serve` shape, pulled off the one union member that has one. */
type Serve = Extract<TailscaleStatus, { state: 'running' }>['serve'];

function running(serve: Serve): TailscaleStatus {
  return {
    state: 'running',
    tailnet: 'alpha@example.com',
    magicDns: true,
    magicDnsSuffix: 'example.ts.net',
    self: SELF,
    peers: PEERS,
    serve,
  };
}

const SERVING_US = { active: true, forOurPort: true, url: 'https://alpha.example.ts.net' };

/**
 * The banners, as text.
 *
 * Scoped to `role="status"` on purpose: the copyable prompt at the bottom of
 * the card explains the same failure modes in prose, so a whole-card text match
 * finds the explanation and reads it as a live warning.
 */
function warnings(): string[] {
  return screen.queryAllByRole('status').map((n) => n.textContent ?? '');
}

/** The command blocks, not the prompt that also contains those commands. */
function commands() {
  return within(screen.getByRole('group', { name: 'Setup commands' }));
}

function mount(props: Partial<Parameters<typeof TailscaleCard>[0]> = {}) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <TailscaleCard port={4123} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tailscale.mockResolvedValue(running(SERVING_US));
});

describe('what is true now', () => {
  it('names the tailnet and reports serving once the probe answers', async () => {
    // A login distinct from the tailnet name: in real life they are often the
    // same string, and a fixture that reuses it cannot tell the two rows apart.
    mount({ remoteHosts: ['alpha.example.ts.net'], remoteUsers: ['owner@example.com'] });
    expect(await screen.findByText('alpha@example.com')).toBeTruthy();
    expect(screen.getByText('owner@example.com')).toBeTruthy();
    expect(screen.getByText(/this console, on 443/)).toBeTruthy();
  });

  it('lists every device, marking this machine and dating an offline one', async () => {
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByText('alpha')).toBeTruthy();
    expect(screen.getByText('this machine')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    // The offline device is the one where "last seen" earns its place.
    expect(screen.getByText(/offline · last seen/)).toBeTruthy();
  });

  it('offers the reachable URL only when both halves agree', async () => {
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    const link = await screen.findByRole('link', { name: 'https://alpha.example.ts.net' });
    expect(link.getAttribute('href')).toBe('https://alpha.example.ts.net');
  });
});

describe('the disagreements, each named with its symptom', () => {
  it('serving with no --remote flag is called out as a 421', async () => {
    // The URL resolves and every request is refused. From this machine
    // everything looks configured.
    mount({ remoteHosts: [] });
    expect(await screen.findByText(/421/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /https:/ })).toBeNull();
  });

  it('flagged but not served is called out as a URL that will not resolve', async () => {
    tailscale.mockResolvedValue(running({ active: false, forOurPort: false }));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByText(/will not resolve/)).toBeTruthy();
  });

  it('serving a different port is not reported as "not serving"', async () => {
    // Distinct states with distinct fixes; collapsing them would tell someone
    // to re-run a serve command that is already running.
    tailscale.mockResolvedValue(running({ active: true, forOurPort: false }));
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    expect(await screen.findByText(/something else/)).toBeTruthy();
  });

  it('two halves naming different hosts is its own warning', async () => {
    mount({ remoteHosts: ['beta.example.ts.net'] });
    expect(await screen.findByText(/only answers to/)).toBeTruthy();
  });

  it('says nothing about flags a server too old to report them cannot answer for', async () => {
    // `remoteHosts` undefined means "this server cannot say" — guessing "none"
    // would accuse a correctly configured console of being misconfigured.
    mount({});
    await screen.findByText('alpha@example.com');
    // Asserted over the banners only: the copyable prompt explains the 421 too,
    // and matching the whole card would find that and call it a warning.
    expect(warnings()).toEqual([]);
  });
});

describe('the degenerate machines', () => {
  it('explains what Tailscale is for when it is not installed', async () => {
    tailscale.mockResolvedValue({ state: 'not-installed' });
    mount({});
    expect(await screen.findByText(/not installed on this machine/)).toBeTruthy();
    // No device table to render, and none invented.
    expect(screen.queryByText('this machine')).toBeNull();
  });

  it("repeats the CLI's own word for a daemon that is not running", async () => {
    tailscale.mockResolvedValue({ state: 'installed-not-running', detail: 'NeedsLogin' });
    mount({});
    expect(await screen.findByText('NeedsLogin')).toBeTruthy();
  });

  it('a server that cannot report at all says so instead of rendering blanks', async () => {
    // An older server 404s this route. The query retries once before it
    // settles, so this waits longer than the default second.
    tailscale.mockRejectedValue(new Error('404'));
    mount({});
    await waitFor(() => expect(screen.getByText(/started before this feature existed/)).toBeTruthy(), {
      timeout: 4000,
    });
  });
});

describe('the commands it prints', () => {
  it("embeds the console's real port, not a hard-coded 4123", async () => {
    tailscale.mockResolvedValue(running({ active: false, forOurPort: false }));
    mount({ port: 5000, remoteHosts: [] });
    // Publishing the wrong port produces a 502 that reads as a Tailscale fault.
    expect(await screen.findByText(/http:\/\/127\.0\.0\.1:5000/)).toBeTruthy();
  });

  it('drops the serve command once serve is already pointed here', async () => {
    mount({ remoteHosts: ['alpha.example.ts.net'] });
    await screen.findByText('alpha@example.com');
    expect(commands().queryByText(/tailscale serve --bg/)).toBeNull();
    // The re-install line stays: flags change more often than the serve does.
    expect(commands().getByText(/agent\.sh install/)).toBeTruthy();
  });
});
