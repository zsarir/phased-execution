/**
 * The page frame: the Suspense boundary, and the three things a hash router has
 * to do by hand that a browser does for free on a real navigation.
 *
 * `app/legacy-route.tsx` until Phase 11 — it was named for the adapter that let
 * a 2.x view render under the 3.0 shell, and outlived every one of those views.
 * What it always actually was is the boundary that keeps the header, the rail
 * and the tab bar painted while the next chunk loads, instead of blanking the
 * app on every tap. That job is permanent; the name was not.
 *
 * The three borrowed jobs, all of which the browser performs on a real page
 * load and none of which happen when only `location.hash` changes:
 *
 * 1. **Focus goes to the new page.** Following a link leaves focus on the link,
 *    which is *inside the nav*, so a keyboard user who has just chosen Insights
 *    is still in the rail and tabs through the whole nav again to reach it.
 *    `<main>` takes `tabIndex={-1}` and is focused on every PATH change (never
 *    on a query change: typing into `?k=` must not steal focus from the
 *    palette). It is focused programmatically, so `:focus-visible` never paints
 *    a ring around the whole page.
 * 2. **The change is announced.** A screen reader says nothing when a hash
 *    changes, so the destination's name is written into a polite live region.
 *    Politely, and only the name: an assertive region would interrupt whatever
 *    is being read, and a whole-page description would be read twice.
 * 3. **The skip link has somewhere to go.** `#main` is the target
 *    `app/shell/layout.tsx` renders as the first focusable thing on the page.
 *
 * `preventScroll` matters on the phone: focusing an element scrolls it into
 * view by default, and `<main>` is the scroller, so the default would fight the
 * shell's own "reset scrollTop on a path change" and land mid-page.
 */

import { Suspense, useEffect, useRef, type ComponentType, type LazyExoticComponent } from 'react';
import { Spinner } from '@/components/ui';
import { destinationFor, type Route } from '@/app/routes';

/** Title-case destination names, for the announcement. */
const SPOKEN: Record<string, string> = {
  now: 'Now',
  plans: 'Plans',
  runs: 'Runs',
  sessions: 'Sessions',
  insights: 'Insights',
  settings: 'Settings',
};

/** What a screen reader is told after a navigation: the destination, and where in it. */
export function routeAnnouncement(route: Route): string {
  const head = route.segments[0];
  const destination = SPOKEN[destinationFor(head) ?? 'now'] ?? 'Now';
  const detail = route.segments.slice(1).filter(Boolean).join(' ');
  return detail ? `${destination}, ${detail}` : destination;
}

export function RouteFrame({
  view: View,
  route,
  fullHeight = false,
}: {
  view: LazyExoticComponent<ComponentType<{ route: Route }>>;
  route: Route;
  /** Sessions owns its height; the shell hands it the remainder. */
  fullHeight?: boolean;
}) {
  const announcement = useRef<HTMLParagraphElement>(null);
  const first = useRef(true);
  // The sentence is computed on every render and READ inside the effect, so
  // the effect depends on a string rather than on the route object — which is
  // what lets it fire on the path and stay silent while a query changes. A
  // dependency on `route` itself would re-announce on every keystroke into
  // `?k=`; a lint suppression would hide that rather than state it.
  const sentence = routeAnnouncement(route);

  useEffect(() => {
    // Not on the first paint: nothing was navigated FROM, and moving focus or
    // announcing on load is noise on top of the page the reader just opened.
    if (first.current) {
      first.current = false;
      return;
    }
    const main = document.querySelector('main');
    if (main instanceof HTMLElement) main.focus({ preventScroll: true });
    if (announcement.current) announcement.current.textContent = sentence;
    // `route.path` — the PATH, never the query. See the header. `sentence` is
    // derived from the path, so it never widens this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.path]);

  const body = (
    <Suspense
      fallback={
        <div className="grid place-items-center py-16">
          <Spinner />
        </div>
      }
    >
      <View route={route} />
    </Suspense>
  );

  return (
    <>
      {/* Written to imperatively rather than rendered from state: a live region
          announces what CHANGES inside it, so it has to exist and be empty
          before the text lands in it. Rendering the text and the region in the
          same commit is the classic way to get silence. */}
      <p ref={announcement} aria-live="polite" aria-atomic="true" className="sr-only" />
      {fullHeight ? <div className="min-h-0 flex-1">{body}</div> : body}
    </>
  );
}
