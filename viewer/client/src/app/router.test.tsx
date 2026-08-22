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
  resolveEntry,
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

  it('sends a retired plan TAB where it went, keeping what the address meant', () => {
    // `plan` is a page, not an alias, so its redirect is about the SECOND
    // segment. Catching it here rather than inside the plan view is what keeps
    // the address bar honest: otherwise it goes on saying `/raw` while the
    // page shows Source, and the next reload has to resolve it again.
    expect(redirectTarget(route('#/plan/demo/overview'))).toBe('#/plan/demo/source');
    // `raw` and `overview` became ONE tab, so the parameter is what keeps them
    // distinguishable — the same device `?focus=` uses for Now's bands.
    expect(redirectTarget(route('#/plan/demo/raw'))).toBe('#/plan/demo/source?view=raw');
    // Analysis left the plan page entirely; `?plan=` is which plan it was about.
    expect(redirectTarget(route('#/plan/demo/analysis'))).toBe('#/insights?plan=demo');
    // A slug that needs encoding survives the round trip.
    expect(redirectTarget(route('#/plan/a%2Fb/raw'))).toBe('#/plan/a%2Fb/source?view=raw');
  });

  it('leaves a LIVE plan tab, and the phase/handoff detail routes, exactly where they are', () => {
    for (const tail of ['route', 'phases', 'run', 'handoffs', 'source', 'phase/3', 'handoff/2']) {
      expect(redirectTarget(route(`#/plan/demo/${tail}`)), tail).toBeNull();
    }
    // And the bare plan address is not a redirect either.
    expect(redirectTarget(route('#/plan/demo'))).toBeNull();
  });

  it('sends the two halves of the notifications head to two different places', () => {
    // The one head whose redirect depends on its DEPTH. The bare address was
    // the announcement log and becomes the drawer; the deeper one was the
    // device register and preferences, and is now a Settings section. One
    // destination for both would take the device register away with the inbox.
    // The bare one is built by `bellHref`, which mints a whole hash; the other
    // is a bare path like every other entry in the table. `navigate()` accepts
    // both, and the difference is which builder owns the URL.
    expect(redirectTarget(route('#/notifications'))).toBe('#/now?bell=1&panel=announcements');
    expect(redirectTarget(route('#/notifications/settings'))).toBe('settings/alerts');
  });

  it('folds the MCP page into Settings, keeping which half of it you asked for', () => {
    // Phase 11 built the section, so the redirect is no longer a broken link
    // with extra steps — the rule `#/ready` and `#/pulse` waited on until
    // Phase 8. The second SEGMENT becomes a query value because
    // `#/settings/:section` is the address space now.
    expect(redirectTarget(route('#/mcp'))).toBe('settings/mcp');
    expect(redirectTarget(route('#/mcp/catalog'))).toBe('settings/mcp?tab=catalog');
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

  it('retires both terminal heads into Sessions, keeping the session id', () => {
    // Phase 10 rebuilt them into one page, so both are redirects — which is
    // exactly why they must still RESOLVE: `#/agent/<id>` is in bookmarks, in
    // handoff prose and in push payloads minted by older servers, and the id
    // is the whole address. `resolveView` returns null for an alias by design
    // (see the note on it), so the entry kind is what is asserted here.
    expect(resolveEntry('terminal').kind).toBe('redirect');
    expect(resolveEntry('agent').kind).toBe('redirect');
    // `resolveView` returns null for an alias by design — a caller that gets
    // null should have followed `redirectTarget` first, and a blank frame with
    // a stack trace beats a silently wrong page.
    expect(resolveView('agent')).toBeNull();
    expect(resolveView('sessions')).toBeTruthy();
    expect(redirectTarget(route('#/agent/abc'))).toBe('sessions/abc');
    expect(redirectTarget(route('#/terminal/abc'))).toBe('sessions/abc');
    // With no id each meant "start one of MY kind" — `?new=` is what keeps
    // that half of the address, the same rule as `#/ready` → `?focus=next`.
    expect(redirectTarget(route('#/terminal'))).toBe('sessions?new=shell');
    expect(redirectTarget(route('#/agent'))).toBe('sessions?new=agent');
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
