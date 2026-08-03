/**
 * Hash routing for the app: the rules from `routes.js`, plus the hook that
 * re-renders when they change.
 *
 * The split is deliberate — this module pulls in the rendering runtime, which
 * is a bare specifier only a browser's import map can resolve, so anything that
 * lives here is unreachable from a Node test. The routing rules themselves are
 * next door and dependency-free, because a server-built notification URL has to
 * agree with them and "it agrees" is a claim worth being able to check.
 */

import { useState, useEffect } from './html.js';

export { parseHash, toHash, navigate, planHref, phaseHref, handoffHref } from './routes.js';

import { parseHash } from './routes.js';

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const update = () => setRoute(parseHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}
