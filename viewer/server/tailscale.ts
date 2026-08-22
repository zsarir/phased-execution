/**
 * What this machine's tailnet looks like, for the Settings card that turns a
 * loopback console into one you can open from your phone.
 *
 * `--remote` (see `server/api/access.ts`) is the half of that story this repo
 * already had: it says which hostnames the console answers to and who may
 * arrive through them. What it could never say is whether any of it is
 * actually *set up* — whether Tailscale is installed, signed in, serving 443
 * at this port, and which of your devices could reach it. Those answers live
 * outside the process, so the card that explains the feature has to go and
 * look. Everything here is that lookup.
 *
 * Three rules the rest of the file exists to keep:
 *
 *   Never throw. This is decoration on a settings page. A machine without
 *   Tailscale, with a half-installed Tailscale, or with a daemon that hangs is
 *   the *normal* case for most people running this console, and none of it may
 *   turn into a 500 next to the buttons that restart the server.
 *
 *   Never pass the CLI's JSON through. `status --json` carries public keys, an
 *   `AuthURL` that would let a stranger join the tailnet, and a per-node
 *   capability map. The card needs a hostname and an online dot. So every
 *   field is copied out by name and nothing else survives — a whitelist, not a
 *   redaction pass, because redaction has to be re-checked every time upstream
 *   adds a field and a whitelist does not.
 *
 *   Cache on time, not on anything this repo watches. Tailnet state changes
 *   when a phone wakes up, which corresponds to no file and no generation
 *   counter — so a plain 30-second memo is the honest expiry, and it also
 *   keeps an open Settings page from shelling out twice a second.
 */

import { execFile } from 'node:child_process';

/** Where macOS puts the CLI when Tailscale came from the App Store build. */
const APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/**
 * How long one `tailscale` invocation may take before it reads as "no answer".
 *
 * Three seconds is right for the product: this is a local CLI on the same
 * machine, the answer feeds a status chip, and a hung probe must not hold a page
 * load. It is NOT right for a test suite — the fixtures fork a bash script, and
 * under a full parallel run that alone has been measured at 2.2s of the 3s
 * budget, so the suite flaked on whichever tailscale test happened to run while
 * the machine was busiest. Overridable rather than widened: production keeps
 * three seconds, and the suite stops depending on how loaded the host is.
 */
const PROBE_TIMEOUT_MS = 3000;
const probeTimeoutMs = (): number => {
  const override = Number(process.env.PHASE_CONSOLE_TAILSCALE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : PROBE_TIMEOUT_MS;
};
const CACHE_MS = 30_000;

export type TailscaleDevice = {
  hostName: string;
  dnsName: string;
  ips: string[];
  os?: string;
  online: boolean;
  /** ISO timestamp, only interesting for a device that is currently offline. */
  lastSeen?: string;
};

/**
 * Whether `tailscale serve` is publishing anything, and whether what it
 * publishes is *this* console.
 *
 * The two are deliberately separate. Serving something else on 443 is a real
 * state with a specific fix (you pointed it at another port), and collapsing
 * it into "not serving" would send someone to re-run a command that is already
 * running.
 */
export type TailscaleServe = {
  active: boolean;
  forOurPort: boolean;
  /** The https URL that reaches this console, only when `forOurPort`. */
  url?: string;
};

export type TailscaleStatus =
  | { state: 'not-installed' }
  | { state: 'installed-not-running'; detail?: string }
  | {
      state: 'running';
      /** The tailnet's name as the CLI reports it. */
      tailnet?: string;
      magicDns: boolean;
      /** e.g. `example.ts.net` — the suffix device names resolve under. */
      magicDnsSuffix?: string;
      self: TailscaleDevice;
      peers: TailscaleDevice[];
      serve: TailscaleServe;
    };

type Cached = { at: number; port: number; value: TailscaleStatus };
let cache: Cached | null = null;

/** Test seam: drop the memo so a probe runs again. */
export function resetTailscaleCache(): void {
  cache = null;
}

type Run = { ok: boolean; stdout: string; code?: string };

/**
 * Run the CLI and come back with something, always.
 *
 * `execFile` reports a missing binary as `ENOENT` on the error rather than a
 * non-zero exit, which is the difference between "not installed" and "installed
 * and unhappy" — so the code is carried out rather than flattened into `ok`.
 *
 * `TERM` is load-bearing and was found the hard way. The macOS app's CLI is a
 * shim in front of the GUI, and with no `TERM` in the environment it concludes
 * it was double-clicked rather than run from a shell — so instead of answering
 * it tries to *open the app*, and prints "The Tailscale GUI failed to start"
 * where the JSON should be. Every shell has `TERM`; launchd hands a job an
 * almost-empty environment, so this worked in every test and on every developer
 * machine and reported `installed-not-running` on the one console that runs
 * supervised, with Tailscale plainly running.
 */
function run(binary: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        timeout: probeTimeoutMs(),
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, TERM: process.env.TERM || 'dumb' },
      },
      (error, stdout) => {
        if (!error) return resolve({ ok: true, stdout: String(stdout) });
        const code = typeof (error as NodeJS.ErrnoException).code === 'string'
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        // A non-zero exit still prints usable JSON in some states, so stdout is
        // kept even on failure.
        resolve({ ok: false, stdout: String(stdout ?? ''), code });
      },
    );
  });
}

function parse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * The first CLI that answers.
 *
 * PATH first, because someone who installed the standalone package has it
 * there and it is the one they would type. The app path second, because on
 * macOS the App Store build ships the CLI *inside* the bundle and shells
 * usually reach it through an alias — an alias being a shell construct, it does
 * not exist for `execFile`, so a machine with a perfectly working `tailscale`
 * at the prompt looks uninstalled to this process without the fallback.
 *
 * `PHASE_CONSOLE_TAILSCALE_BIN` replaces the search rather than extending it.
 * Someone who names a path has told us where it is, and quietly carrying on to
 * a different binary when that one is missing would report on an installation
 * they did not ask about.
 */
async function locate(args: string[]): Promise<{ binary: string; result: Run } | null> {
  const override = process.env.PHASE_CONSOLE_TAILSCALE_BIN;
  for (const binary of override ? [override] : ['tailscale', APP_BINARY]) {
    const result = await run(binary, args);
    if (result.code !== 'ENOENT') return { binary, result };
  }
  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function ips(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((ip): ip is string => typeof ip === 'string') : [];
}

/** A node, reduced to the fields the card renders. Nothing else is copied. */
function device(node: Record<string, unknown>): TailscaleDevice {
  const dnsName = (str(node.DNSName) ?? '').replace(/\.$/, '');
  const online = node.Online === true;
  return {
    hostName: str(node.HostName) ?? dnsName ?? '',
    dnsName,
    ips: ips(node.TailscaleIPs),
    ...(str(node.OS) ? { os: str(node.OS) } : {}),
    online,
    // Only when it adds something: "last seen" on a device that is online now
    // is a timestamp from a second ago, and reads as staleness that isn't there.
    ...(!online && str(node.LastSeen) ? { lastSeen: str(node.LastSeen) } : {}),
  };
}

/**
 * Read `serve status --json` for a 443 handler pointing at `port`.
 *
 * The shape is `{TCP: {443: {HTTPS: true}}, Web: {"host:443": {Handlers:
 * {"/": {Proxy: "http://127.0.0.1:4123"}}}}}`. Parsing the JSON rather than the
 * human output matters because the text form is laid out for reading and has
 * changed between releases, while these keys are what the API returns.
 */
function serveFrom(json: Record<string, unknown> | null, port: number): TailscaleServe {
  if (!json) return { active: false, forOurPort: false };

  const web = json.Web;
  if (!web || typeof web !== 'object') return { active: false, forOurPort: false };

  const entries = Object.entries(web as Record<string, unknown>);
  if (!entries.length) return { active: false, forOurPort: false };

  for (const [hostPort, config] of entries) {
    const handlers = (config as Record<string, unknown> | null)?.Handlers;
    if (!handlers || typeof handlers !== 'object') continue;
    for (const handler of Object.values(handlers as Record<string, unknown>)) {
      const proxy = str((handler as Record<string, unknown> | null)?.Proxy) ?? '';
      // Both spellings of loopback reach us, and a bare `4123` is accepted by
      // the CLI too — so match on the port at the end rather than on one exact
      // string, or a working setup reads as a mismatch and the card tells
      // someone to fix what is already right.
      if (new RegExp(`(^|[:/])(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`).test(proxy.replace(/\/$/, ''))) {
        const host = hostPort.replace(/:443$/, '');
        return { active: true, forOurPort: true, url: `https://${host}` };
      }
    }
  }

  // Something is served, but not us.
  return { active: true, forOurPort: false };
}

async function probe(port: number): Promise<TailscaleStatus> {
  const found = await locate(['status', '--json']);
  if (!found) return { state: 'not-installed' };

  const json = parse(found.result.stdout);
  if (!json) {
    // Installed, but it could not tell us anything — almost always a daemon
    // that is not running. The CLI's stderr is not repeated: it names local
    // socket paths, and this string goes on a page.
    return { state: 'installed-not-running', detail: 'the Tailscale daemon is not responding' };
  }

  const backend = str(json.BackendState);
  if (backend !== 'Running') {
    return {
      state: 'installed-not-running',
      // `NeedsLogin`, `Stopped`, `NoState` — the CLI's own vocabulary, which is
      // also what its documentation and error messages use.
      ...(backend ? { detail: backend } : {}),
    };
  }

  const tailnet = json.CurrentTailnet as Record<string, unknown> | undefined;
  const self = json.Self as Record<string, unknown> | undefined;

  const peers = Object.values((json.Peer as Record<string, unknown> | undefined) ?? {})
    .filter((peer): peer is Record<string, unknown> => !!peer && typeof peer === 'object')
    .map(device)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName));

  const serveResult = await run(found.binary, ['serve', 'status', '--json']);

  return {
    state: 'running',
    ...(str(tailnet?.Name) ? { tailnet: str(tailnet?.Name) } : {}),
    magicDns: tailnet?.MagicDNSEnabled === true,
    ...(str(json.MagicDNSSuffix) ? { magicDnsSuffix: str(json.MagicDNSSuffix) } : {}),
    self: device(self ?? {}),
    peers,
    serve: serveFrom(parse(serveResult.stdout), port),
  };
}

/**
 * The tailnet as it looks right now, memoised for 30 seconds.
 *
 * Keyed on the port as well as the clock: the console's port is fixed for a
 * process, but a test that asks about two ports in the same second is asking
 * two different questions and must not get one answer.
 */
export async function tailscaleStatus(port: number): Promise<TailscaleStatus> {
  const now = Date.now();
  if (cache && cache.port === port && now - cache.at < CACHE_MS) return cache.value;

  let value: TailscaleStatus;
  try {
    value = await probe(port);
  } catch {
    // Belt and braces: `probe` is written not to throw, and if it ever does,
    // the settings page still renders.
    value = { state: 'not-installed' };
  }

  cache = { at: now, port, value };
  return value;
}
