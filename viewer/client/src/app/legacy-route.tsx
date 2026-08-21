import { Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { Spinner } from '@/components/ui';
import type { Route } from '@/app/routes';

/**
 * The adapter that lets a 2.x view render inside the 3.0 shell, unchanged.
 *
 * Phase 3 rebuilds the *shell*: the routes, the six destinations, the header,
 * the three overlays. It deliberately rebuilds no pages — that is Phases 6–10 —
 * so for one phase every old view has to keep working under new chrome. This is
 * the whole of the contract that makes that true, and stating it as a component
 * rather than as a convention is what stops each page inventing its own.
 *
 * **The contract.** A legacy view is a default-exported component taking one
 * prop, `route: { segments, query, path }`, and rendering its own `<Page>` frame
 * (title, subtitle, actions) inside the shell's one scroller. It may navigate
 * with `navigate()` from `@/app/router`. It knows nothing about the header, the
 * rail, the tab bar or the overlays, and it must not try to: a page that reaches
 * into the chrome is a page that cannot be replaced without touching the shell.
 * When a phase rebuilds one of these, it drops `LegacyRoute` and moves the view
 * under `features/<destination>/`, and nothing else changes.
 *
 * The one thing this adds beyond `<View route={route} />` is the Suspense
 * boundary. Each page is its own chunk, so *every* navigation suspends for as
 * long as the chunk takes; putting the boundary here rather than around the
 * whole shell is what keeps the header, the rail and the tab bar painted while
 * the next page loads, instead of blanking the app on every tap.
 */
export function LegacyRoute({
  view: View,
  route,
  fullHeight = false,
}: {
  view: LazyExoticComponent<ComponentType<{ route: Route }>>;
  route: Route;
  /** Terminal and agent own their height; the shell hands them the remainder. */
  fullHeight?: boolean;
}) {
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

  return fullHeight ? <div className="min-h-0 flex-1">{body}</div> : body;
}
