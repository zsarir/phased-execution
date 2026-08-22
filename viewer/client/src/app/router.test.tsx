/**
 * The route-registry guard.
 *
 * `ROUTE_HEADS` is shared with the server: `server/push/catalogue.ts` builds
 * every notification deep link from the same vocabulary, and the Node suite
 * asserts each `routeFor` destination is a member of it. This test closes the
 * other half — that each member actually resolves here. Without both, a head can
 * be renamed on one side and a push notification opens a blank page, which is
 * exactly the failure that stays invisible until someone taps one.
 *
 * 3.0 widened what "resolves" means. A head is now either a page or an alias, so
 * the assertions below walk the whole table and then follow every alias to the
 * page it lands on — because a redirect onto a head that does not exist is the
 * same broken link as a missing view, and is easier to write by accident.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ROUTE_HEADS } from '@shared/route-meta.js';
import {
  DEFAULT_HEAD,
  DESTINATIONS,
  MemoryRouterProvider,
  ROUTE_TABLE,
  destinationFor,
  redirectTarget,
  resolveHead,
  resolveView,
  useNavigate,
  useRoute,
} from './router';
import { parseHash, type Route } from './routes';

const route = (hash: string): Route => parseHash(hash) as Route;

describe('the route table', () => {
  it('has an entry for every shared route head', () => {
    const missing = (ROUTE_HEADS as readonly string[]).filter((head) => !(head in ROUTE_TABLE));
    expect(missing, `heads with no entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('holds nothing the shared vocabulary does not declare', () => {
    const extra = Object.keys(ROUTE_TABLE).filter(
      (head) => !(ROUTE_HEADS as readonly string[]).includes(head),
    );
    expect(extra, `entries with no head: ${extra.join(', ')}`).toEqual([]);
  });

  it('makes every page a lazy component', () => {
    for (const [head, entry] of Object.entries(ROUTE_TABLE)) {
      if (entry.kind !== 'page') continue;
      // React marks lazy components with this tag; a plain object would render
      // as nothing and only fail once someone navigated there.
      expect((entry.lazy as unknown as { $$typeof: symbol }).$$typeof, head).toBe(Symbol.for('react.lazy'));
    }
  });

  it('sends the empty hash and any unknown head to Now', () => {
    expect(DEFAULT_HEAD).toBe('now');
    expect(resolveHead(undefined)).toBe('now');
    expect(resolveHead('')).toBe('now');
    expect(resolveHead('nope')).toBe('now');
  });
});

describe('the aliases', () => {
  it('lands every alias on a real page, in one hop', () => {
    for (const [head, entry] of Object.entries(ROUTE_TABLE)) {
      if (entry.kind !== 'redirect') continue;
      const target = entry.to(route(`#/${head}`));
      const landed = ROUTE_TABLE[target.replace(/^#?\/?/, '').split(/[/?]/)[0]!];
      expect(landed, `${head} → ${target}`).toBeTruthy();
      // One hop. A redirect onto a redirect is a loop waiting to be written.
      expect(landed!.kind, `${head} → ${target}`).toBe('page');
    }
  });

  it('carries what the old URL said with it', () => {
    expect(redirectTarget(route('#/dashboard'))).toBe('now');
    // The search term becomes the palette's.
    expect(redirectTarget(route('#/search?q=cart%20api'))).toBe('#/now?k=cart+api');
    // Both halves of a guide address survive.
    expect(redirectTarget(route('#/guide/mobile?card=tailscale'))).toBe('#/now?help=mobile&card=tailscale');
    expect(redirectTarget(route('#/stats?plan=alpha'))).toBe('insights?plan=alpha');
    // The announcements are ONE PANEL of the drawer now, and the redirect names
    // it: this address always meant the log of what was said, never the list of
    // what is still waiting, and letting the drawer's own default decide would
    // have quietly changed what the old link opens.
    expect(redirectTarget(route('#/notifications'))).toBe('#/now?bell=1&panel=announcements');
    // Phase 8: the departures board and the Pulse are two SECTIONS of Now, so
    // each keeps its meaning in `?focus=` rather than landing on the top of a
    // page that answers four questions.
    expect(redirectTarget(route('#/ready'))).toBe('#/now?focus=next');
    expect(redirectTarget(route('#/pulse'))).toBe('#/now?focus=lanes');
  });

  it('leaves the notification SETTINGS page alone — only the bare head retired', () => {
    // Phase 11 folds it into Settings; until then it is a page, and a redirect
    // here would take the device register away with the inbox.
    expect(redirectTarget(route('#/notifications/settings'))).toBeNull();
  });

  it('does not redirect a page whose new home has not been built', () => {
    // Settings grows an MCP section in Phase 11. Until then a redirect would be
    // a broken link with extra steps — which is the rule `#/ready` and
    // `#/pulse` waited on until Phase 8 built the sections that answer them.
    for (const hash of ['#/mcp']) {
      expect(redirectTarget(route(hash)), hash).toBeNull();
    }
  });
});

describe('every old deep link still resolves', () => {
  // Exactly the list in the plan's exit criteria, plus the two shapes
  // `routeFor` builds with an id.
  const OLD = [
    '#/',
    '#/dashboard',
    '#/ready',
    '#/pulse',
    '#/notifications',
    '#/notifications/settings',
    '#/agent',
    '#/agent/abc123',
    '#/terminal',
    '#/terminal/abc123',
    '#/mcp',
    '#/stats',
    '#/search?q=cart',
    '#/guide/mobile?card=tailscale',
    '#/source',
    '#/plans',
    '#/plan/alpha/run',
    '#/plan/alpha/phase/8',
    '#/runs',
    '#/settings',
  ];

  it('ends on a page, never on the fallback by accident', () => {
    for (const hash of OLD) {
      const parsed = route(hash);
      const target = redirectTarget(parsed);
      const head = target
        ? route(target.startsWith('#') ? target : `#/${target}`).segments[0]
        : parsed.segments[0];
      const entry = ROUTE_TABLE[resolveHead(head)];
      expect(entry.kind, hash).toBe('page');
    }
  });
});

describe('what the navigation lights up', () => {
  it('keeps a plan under Plans and a session page under Sessions', () => {
    expect(destinationFor('plan')).toBe('plans');
    // The one the old registry could not express: a terminal deep link used to
    // light up nothing at all, because `terminal` was not a nav entry.
    expect(destinationFor('terminal')).toBe('sessions');
    expect(destinationFor('agent')).toBe('sessions');
    expect(destinationFor('terminal')).not.toBe('now');
    expect(destinationFor('agent')).not.toBe('now');
  });

  it('resolves the terminal to its OWN page, gated or not', () => {
    // Sessions is where these are rebuilt (Phase 10), not where they go today.
    // Redirecting now would make a deep link from a phone look like a broken
    // app for two phases.
    expect(resolveHead('terminal')).toBe('terminal');
    expect(resolveHead('agent')).toBe('agent');
    expect(resolveView('terminal')).toBeTruthy();
  });

  it('names a destination for every head, and one of the six', () => {
    for (const head of ROUTE_HEADS as readonly string[]) {
      const destination = destinationFor(head);
      // `source` is chromeless — it renders instead of the shell.
      if (head === 'source') {
        expect(destination).toBeUndefined();
        continue;
      }
      expect(DESTINATIONS as readonly string[], head).toContain(destination);
    }
  });
});

describe('the memory router', () => {
  function Probe() {
    const here = useRoute();
    const go = useNavigate();
    return (
      <button type="button" onClick={() => go('plans')}>
        {here.path || '(root)'}
      </button>
    );
  }

  it('renders at a route and moves without touching the address bar', () => {
    const before = window.location.hash;
    const onNavigate = vi.fn();
    render(
      <MemoryRouterProvider initial="#/plan/alpha/run" onNavigate={onNavigate}>
        <Probe />
      </MemoryRouterProvider>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('plan/alpha/run');

    fireEvent.click(screen.getByRole('button'));
    expect(onNavigate).toHaveBeenCalledWith('#/plans');
    expect(screen.getByRole('button')).toHaveTextContent('plans');
    expect(window.location.hash).toBe(before);
  });
});
