/**
 * The route-registry guard.
 *
 * `ROUTE_HEADS` is shared with the server: `server/push/catalogue.ts` builds
 * every notification deep link from the same vocabulary, and the Node suite
 * asserts each `routeFor` destination is a member of it. This test closes the
 * other half — that each member actually resolves to a component here. Without
 * both, a head can be renamed on one side and a push notification opens a blank
 * page, which is exactly the failure that is invisible until someone taps one.
 */

import { describe, expect, it } from 'vitest';
import { ROUTE_HEADS } from '@shared/route-meta.js';
import { DEFAULT_HEAD, VIEWS, resolveHead, resolveView } from './router';

describe('route registry', () => {
  it('registers a view for every shared route head', () => {
    const missing = (ROUTE_HEADS as readonly string[]).filter((head) => !(head in VIEWS));
    expect(missing, `heads with no view: ${missing.join(', ')}`).toEqual([]);
  });

  it('registers nothing the shared vocabulary does not declare', () => {
    const extra = Object.keys(VIEWS).filter((head) => !(ROUTE_HEADS as readonly string[]).includes(head));
    expect(extra, `views with no head: ${extra.join(', ')}`).toEqual([]);
  });

  it('resolves every head to a lazy component', () => {
    for (const head of ROUTE_HEADS as readonly string[]) {
      const view = resolveView(head);
      expect(view, head).toBeTypeOf('object');
      // React marks lazy components with this tag; a plain object would render
      // as nothing and only fail once someone navigated there.
      expect((view as unknown as { $$typeof: symbol }).$$typeof, head).toBe(Symbol.for('react.lazy'));
    }
  });

  it('sends the empty hash and any unknown head to the dashboard', () => {
    expect(resolveHead(undefined)).toBe(DEFAULT_HEAD);
    expect(resolveHead('')).toBe(DEFAULT_HEAD);
    expect(resolveHead('nope')).toBe(DEFAULT_HEAD);
  });

  it('resolves the terminal to its own page, gated or not', () => {
    // The gate is `--allow-terminal` on the server, and the page explains
    // itself when it is off. Resolving to the dashboard instead would make a
    // deep link from a phone look like a broken app.
    expect(resolveHead('terminal')).toBe('terminal');
    expect(resolveHead('terminal')).not.toBe(DEFAULT_HEAD);
  });
});
