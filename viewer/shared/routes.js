/**
 * Hash routing, as pure functions.
 *
 * Kept apart from `router.js` because that module owns the `useRoute` hook and
 * therefore pulls in the rendering runtime, and the rendering runtime is a bare
 * specifier the browser resolves from an import map. Nothing in Node can load
 * it — so the routing *rules*, which are exactly what a server-built
 * notification URL has to agree with, were untestable purely by association.
 *
 * They are the same rules either way:
 *   #/plans                    #/plan/<slug>/route
 *   #/plan/<slug>/phase/8      #/plan/<slug>/handoff/7
 *   #/ready  #/stats  #/search?q=…  #/settings  #/source  #/notifications
 */

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart ?? ''));
  return { segments, query, path: pathPart };
}

/**
 * `path` may arrive in any of the forms this app produces: `plans`, `/plans`,
 * `#/plans`, or the `/#/plans` a server-built notification URL carries (that
 * one has to be a URL path, because a service worker resolves it against the
 * origin). All four mean the same route, and normalising here is what lets
 * `routeFor` on the server stay the single place a destination is decided.
 */
export function toHash(path) {
  return `#/${String(path).replace(/^\/?#?\/?/, '')}`;
}

export function navigate(path, { replace = false } = {}) {
  const target = toHash(path);
  if (location.hash === target) return;
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function planHref(slug, tab = 'route') {
  return `#/plan/${encodeURIComponent(slug)}/${tab}`;
}

export function phaseHref(slug, phase) {
  return `#/plan/${encodeURIComponent(slug)}/phase/${phase}`;
}

export function handoffHref(slug, phase) {
  return `#/plan/${encodeURIComponent(slug)}/handoff/${phase}`;
}
