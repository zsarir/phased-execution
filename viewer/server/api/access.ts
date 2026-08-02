/**
 * Who is allowed to talk to this console.
 *
 * The console binds to loopback and, for most of its life, that IS the access
 * control: the only thing that can reach it is something already running as
 * you. `--remote` keeps that bind and puts an authenticating proxy in front of
 * it — `tailscale serve` is the case this was written for — so the console can
 * be driven from a phone without ever being exposed to a network.
 *
 * The proxy's job is to prove who is calling. It terminates TLS, authenticates
 * the caller against the tailnet, and forwards to 127.0.0.1 with the caller's
 * login in a header it sets itself. That header is only worth anything because
 * the app never leaves loopback: if the app listened on a network interface,
 * anyone could send the header themselves. Tailscale documents this exactly —
 * "it's best practice to only have the service listen on localhost" — and it is
 * why `--remote` deliberately does not widen `--host`.
 *
 * The residual risk is another process on this machine spoofing the header.
 * That is accepted: a process running as you can start `claude` itself, so the
 * console is not the weak link.
 *
 * The rule, when `--remote` is set, is a pair rather than two separate checks:
 *
 *   loopback Host + no identity header  → a local client. As it always was.
 *   remote Host   + allowlisted login   → the proxy, carrying someone allowed.
 *   anything else                       → refused.
 *
 * The "anything else" is doing real work. A caller on the tailnet can put
 * whatever they like in the Host header, so `Host: 127.0.0.1:4123` sent through
 * the proxy would otherwise read as local and skip the identity check entirely.
 * It cannot: the proxy sets the identity header on everything it forwards, and
 * a loopback Host carrying one is a combination no honest client produces.
 *
 * With `--remote` unset — the default — none of this runs and every request is
 * treated exactly as it was before this file existed.
 */

import type { IncomingMessage } from 'node:http';

import type { Flags } from '../config.ts';

/** The header `tailscale serve` fills with the authenticated caller's login. */
export const IDENTITY_HEADER = 'tailscale-user-login';

const LOOPBACK = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export type Verdict =
  | { ok: true; scope: 'local' | 'remote'; login: string | null }
  | { ok: false; status: number; message: string; reason: string };

/**
 * The Host header without its port.
 *
 * Bracketed IPv6 (`[::1]:4123`) and bare IPv6 (`::1`) both have to survive
 * this, so a colon alone is not enough to mean "port".
 */
export function hostnameOf(header: string | undefined): string {
  const raw = (header ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1) || raw;
  const colons = raw.split(':').length - 1;
  if (colons > 1) return raw; // bare IPv6, no port
  return raw.replace(/:\d+$/, '').replace(/\.$/, '');
}

export function classify(req: IncomingMessage, flags: Flags): Verdict {
  const login = headerValue(req.headers[IDENTITY_HEADER]);

  // Local-only console: unchanged behaviour, including for anyone who runs it
  // behind their own proxy or on a wider `--host`.
  if (!flags.remoteHosts.length) return { ok: true, scope: 'local', login: null };

  const host = hostnameOf(req.headers.host);
  const loopback = LOOPBACK.has(host);

  if (loopback && !login) return { ok: true, scope: 'local', login: null };

  if (loopback) {
    return {
      ok: false,
      status: 421,
      reason: 'proxied-as-local',
      message: 'This request arrived through a proxy but asks for a local hostname. '
        + 'Use the name the proxy serves.',
    };
  }

  if (!flags.remoteHosts.includes(host)) {
    return {
      ok: false,
      status: 421,
      reason: 'unknown-host',
      message: `This console does not answer to "${host || '(no Host header)'}".`,
    };
  }

  if (!login) {
    return {
      ok: false,
      status: 403,
      reason: 'no-identity',
      message: 'No caller identity. This hostname is only reachable through an authenticating '
        + 'proxy, and the proxy did not say who you are.',
    };
  }

  if (!flags.remoteUsers.includes(login)) {
    return {
      ok: false,
      status: 403,
      reason: 'not-allowed',
      message: `${login} is not allowed to use this console.`,
    };
  }

  return { ok: true, scope: 'remote', login };
}

/**
 * A repeated header arrives as an array. Taking the first would let a caller
 * bury the real value behind one of their own, so a duplicated identity is no
 * identity at all.
 */
function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return null;
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed || null;
}
