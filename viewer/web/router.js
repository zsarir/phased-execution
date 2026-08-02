/**
 * Hash routing, so every view is a link you can paste to someone:
 *   #/plans                    #/plan/<slug>/route
 *   #/plan/<slug>/phase/8      #/plan/<slug>/handoff/7
 *   #/ready  #/stats  #/search?q=…  #/settings  #/source
 */

import { useState, useEffect } from './html.js';

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart ?? ''));
  return { segments, query, path: pathPart };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#/${String(path).replace(/^#?\/?/, '')}`;
  if (location.hash === target) return;
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const update = () => setRoute(parseHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
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
