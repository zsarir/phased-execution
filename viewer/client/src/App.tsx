import { Suspense, useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { useSseStatus } from '@/lib/sse';
import { shellCounts, useApprovals, useConsoleState, useLiveData, usePlans } from '@/lib/queries';
import { Banner, Spinner, Toaster, TooltipProvider } from '@/components/ui';
import { CHROMELESS_HEADS, navigate, resolveView, useRoute } from '@/router';
import { Rail } from '@/shell/rail';
import { MoreSheet, TabBar, TopBar } from '@/shell/phone';

/** `head` → shortcut, for a keyboard on a desktop. */
const SHORTCUTS: Record<string, string> = {
  '/': 'search', r: 'ready', p: 'plans', d: 'dashboard', s: 'stats', g: 'guide', n: 'notifications',
};

export function App() {
  const route = useRoute();
  const head = route.segments[0];
  const phone = usePhone();
  const sse = useSseStatus();
  const [moreOpen, setMoreOpen] = useState(false);

  // Every server event, wired to what it makes stale. Mounted once, here.
  useLiveData();

  const { data: state, error: stateError } = useConsoleState();
  const rootOk = Boolean(state?.root?.ok);
  const { data: plans } = usePlans(rootOk);
  // Nothing to poll on a server that predates the runner — asking anyway just
  // fills the browser console with 404s.
  const { data: approvals } = useApprovals(Boolean(state?.autopilot));

  const counts = shellCounts(plans, approvals, state?.unread ?? 0);

  // Going anywhere closes the sheet — including "back", which is the gesture a
  // sheet is most often dismissed with.
  useEffect(() => { setMoreOpen(false); }, [route.path]);
  useEffect(() => { if (!phone) setMoreOpen(false); }, [phone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const target = SHORTCUTS[event.key];
      if (!target) return;
      event.preventDefault();
      navigate(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (stateError) {
    return (
      <div className="grid min-h-dvh place-items-center p-4">
        <Banner severity="error">{String((stateError as Error).message ?? stateError)}</Banner>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner label="Starting" />
      </div>
    );
  }

  const View = resolveView(head);

  // The guide is what you read before you have set anything up, so it is the one
  // view that does not send you to the directory picker first.
  const needsSource = (!rootOk || CHROMELESS_HEADS.has(head ?? '')) && head !== 'guide';

  if (needsSource) {
    const SourceView = resolveView('source');
    return (
      <TooltipProvider delayDuration={300}>
        <Suspense fallback={<div className="grid min-h-dvh place-items-center"><Spinner /></div>}>
          <SourceView route={route} />
        </Suspense>
        <Toaster />
      </TooltipProvider>
    );
  }

  const pickSource = () => navigate('source');

  return (
    <TooltipProvider delayDuration={300}>
      <div
        // `.is-phone` is the shell contract: the class the layout, the tests and
        // the browser checks all agree means "top bar + tab bar, no rail".
        className={cn(
          'grid h-dvh overflow-hidden bg-ground',
          phone
            // rows: top bar · the only scrolling region · tab bar
            ? 'is-phone grid-rows-[auto_minmax(0,1fr)_auto]'
            : 'grid-cols-[auto_minmax(0,1fr)]',
        )}
      >
        {phone ? (
          <TopBar state={state} counts={counts} head={head} onPickSource={pickSource} />
        ) : (
          <Rail state={state} counts={counts} head={head} onPickSource={pickSource} />
        )}

        <main className="min-w-0 overflow-y-auto overscroll-contain">
          {(state.serverStale || sse !== 'live') && (
            <div className="flex flex-col gap-2 px-3 pt-3 md:px-5">
              {state.serverStale && (
                <Banner severity="warn">
                  <div className="min-w-0">
                    <strong>This console is running older code than is on disk.</strong>{' '}
                    Node loads the server once, at startup — the page reloads from disk but the
                    process cannot. Restart it, or a fix you already have will look like it did
                    not work.
                  </div>
                </Banner>
              )}
              {sse !== 'live' && (
                <Banner severity={sse === 'offline' ? 'error' : 'info'}>
                  <WifiOff size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    {sse === 'offline'
                      ? 'Live updates stopped. Reload to reconnect.'
                      : 'Reconnecting to the console — the board may be a moment behind.'}
                  </div>
                </Banner>
              )}
            </div>
          )}

          <Suspense fallback={<div className="grid place-items-center py-16"><Spinner /></div>}>
            <View route={route} />
          </Suspense>
        </main>

        {phone && (
          <TabBar
            counts={counts}
            head={head}
            moreOpen={moreOpen}
            onMore={() => setMoreOpen((open) => !open)}
          />
        )}
      </div>

      {phone && (
        <MoreSheet
          open={moreOpen}
          onOpenChange={setMoreOpen}
          state={state}
          counts={counts}
          head={head}
          onPickSource={pickSource}
        />
      )}

      <Toaster />
    </TooltipProvider>
  );
}
