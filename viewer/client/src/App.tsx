import { Suspense, useEffect, useRef, useState } from 'react';
import { Power, WifiOff } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { useOnline, useServiceWorker } from '@/lib/pwa';
import { onSse, useSseStatus } from '@/lib/sse';
import { useConsoleStopped } from '@/lib/shutdown';
import {
  shellCounts,
  useApprovals,
  useConsoleState,
  useLiveData,
  useMcp,
  usePlans,
  useSessions,
} from '@/lib/queries';
import { Banner, Spinner, Toaster, TooltipProvider, toast } from '@/components/ui';
import { installAppHeight, useKeyboardOpen } from '@/lib/viewport';
import { CHROMELESS_HEADS, FULL_HEIGHT_HEADS, navigate, resolveView, useRoute } from '@/router';
import { Disconnected } from '@/shell/disconnected';
import { Rail } from '@/shell/rail';
import { MoreSheet, TabBar, TopBar } from '@/shell/phone';

/** `head` → shortcut, for a keyboard on a desktop. */
const SHORTCUTS: Record<string, string> = {
  '/': 'search',
  r: 'ready',
  p: 'plans',
  d: 'dashboard',
  s: 'stats',
  g: 'guide',
  n: 'notifications',
};

/**
 * A recovery session's verdict, toasted as it lands.
 *
 * The `recovery-outcome` payload had no client consumer at all for a while —
 * the run was fixed on disk and every open tab kept its halt banner. The query
 * invalidation lives in `patchSessions`; this is only the sentence.
 */
function useRecoveryOutcomeToasts(): void {
  useEffect(
    () =>
      onSse('sessions', (data) => {
        const record = data as {
          type?: string;
          recovery?: { fixed?: boolean; headline?: string; detail?: string; synced?: boolean };
        };
        if (record.type !== 'recovery-outcome' || !record.recovery) return;
        const { fixed, noDefect, headline, detail, synced } = record.recovery as {
          fixed?: boolean;
          noDefect?: boolean;
          headline?: string;
          detail?: string;
          synced?: boolean;
        };
        if (fixed) {
          toast(`${headline ?? 'Recovery finished'}${synced ? ' — the run record moved with it' : ''}`, 'ok');
        } else if (noDefect) {
          // The recovery LOOKED and found nothing wrong — a verdict, not a
          // failure. This used to toast as a warning ("ended without moving the
          // board"), the exact inversion of what happened.
          toast(
            `${headline ?? 'Recovery verified'} — nothing was wrong; the halt is stood down and the board is unchanged.`,
            'ok',
          );
        } else {
          toast(
            headline
              ? `${headline} — ${detail ?? 'inspect the session'}`
              : 'Recovery ended without moving the board',
            'warn',
          );
        }
      }),
    [],
  );
}

export function App() {
  const route = useRoute();
  const head = route.segments[0];
  const phone = usePhone();
  const sse = useSseStatus();
  const online = useOnline();
  const stopped = useConsoleStopped();
  const keyboardOpen = useKeyboardOpen();
  const [moreOpen, setMoreOpen] = useState(false);
  const main = useRef<HTMLElement>(null);

  // Every server event, wired to what it makes stale. Mounted once, here.
  useLiveData();
  // `--app-height` follows the visual viewport (the keyboard, mostly) — the
  // shell's height token. Once, for the app's life.
  useEffect(() => installAppHeight(), []);
  // The one scroller is a PERSISTENT node — React swaps its children, so its
  // scrollTop survived every route change: scroll a 65-plan list, tap Ready,
  // land mid-page. Reset on the PATH (never the query — typing in `#/search?q=`
  // must not jump); the guide's `?card=` anchor runs after Suspense resolves,
  // i.e. after this.
  useEffect(() => {
    // Full-height routes have no scrollTop to reset — main does not scroll there.
    if (!FULL_HEIGHT_HEADS.has(route.segments[0] ?? '')) main.current?.scrollTo(0, 0);
  }, [route.path, route.segments]);
  // Registers the worker and offers an update when one is waiting. Also once.
  useServiceWorker();
  // The recovery verdict, said where the person is looking. The notification
  // leg announces it too; this is the in-page echo of the same event the run
  // queries re-read themselves off (`patchSessions`).
  useRecoveryOutcomeToasts();

  const {
    data: state,
    error: stateError,
    isFetching: stateFetching,
    refetch: refetchState,
  } = useConsoleState();
  const rootOk = Boolean(state?.root?.ok);
  const { data: plans } = usePlans(rootOk);
  // Nothing to poll on a server that predates the runner — asking anyway just
  // fills the browser console with 404s.
  const { data: approvals } = useApprovals(Boolean(state?.autopilot));
  // Sessions outlive the page that opened them, so the badge has to be shell-wide
  // rather than something the Agent/Terminal pages know while you are on them.
  const { data: sessions } = useSessions(state);
  const { data: mcp } = useMcp();

  const counts = shellCounts(plans, approvals, state?.unread ?? 0, sessions?.sessions, mcp?.servers);

  // Going anywhere closes the sheet — including "back", which is the gesture a
  // sheet is most often dismissed with.
  useEffect(() => {
    setMoreOpen(false);
  }, [route.path]);
  useEffect(() => {
    if (!phone) setMoreOpen(false);
  }, [phone]);

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

  // The queries are invalidated by the stream, not by a timer, so nothing
  // retries on its own once this one has failed. Coming back onto a network is
  // the one moment it is worth asking again unprompted.
  //
  // ⚠️ On the *transition*, never on "online && errored". Every failure is a new
  // Error object, so an effect that depends on the error refetches, fails,
  // produces a different error, and refetches again — a request every
  // millisecond, and a permanent spinner instead of the offline screen, because
  // the query is always mid-retry and never settled. Found in a browser; the
  // regression test is `app.test.tsx`.
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameBack = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameBack) void refetchState();
  }, [online, refetchState]);

  // With several consoles open, every tab is called "Phase Console" and the tab
  // strip becomes a guessing game. The instance name goes first because that is
  // what survives truncation — a browser given ten tabs shows about twelve
  // characters, and "hub · Phase…" identifies the tab where "Phase Cons…" does
  // not. A server too old to report an instance keeps the plain title.
  const instanceName = state?.instance?.name;
  useEffect(() => {
    document.title = instanceName ? `${instanceName} · Phase Console` : 'Phase Console';
  }, [instanceName]);

  if (stateError) {
    return (
      <Disconnected
        online={online}
        detail={String((stateError as Error).message ?? stateError)}
        onRetry={() => {
          void refetchState();
        }}
        retrying={stateFetching}
      />
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
        <Suspense
          fallback={
            <div className="grid min-h-dvh place-items-center">
              <Spinner />
            </div>
          }
        >
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
          // h-(--app-height), not h-dvh: dvh ignores the software keyboard on
          // iOS. The token falls back to 100dvh where visualViewport is absent.
          'grid h-(--app-height) overflow-hidden bg-ground',
          phone
            ? // rows: top bar · the only scrolling region · tab bar
              'is-phone grid-rows-[auto_minmax(0,1fr)_auto]'
            : 'grid-cols-[auto_minmax(0,1fr)]',
        )}
      >
        {phone ? (
          <TopBar state={state} counts={counts} head={head} onPickSource={pickSource} />
        ) : (
          <Rail state={state} counts={counts} head={head} onPickSource={pickSource} />
        )}

        {/* `overscroll-none`, not `contain`: `contain` stops the scroll
            *chaining* to the document but leaves the rubber band, so a flick
            past the last card still bounces a strip of empty ground into view
            above the tab bar. */}
        <main
          ref={main}
          className={
            FULL_HEIGHT_HEADS.has(head ?? '')
              ? // Terminal/agent own their height: banners stay in flow and the
                // frame gets the definite remainder — never a second scroller.
                'flex min-w-0 flex-col overflow-hidden'
              : 'min-w-0 overflow-y-auto overscroll-none'
          }
        >
          {(state.serverStale || stopped || !online || sse !== 'live') && (
            <div className="flex shrink-0 flex-col gap-2 px-3 pt-3 md:px-5">
              {state.serverStale && (
                <Banner severity="warn">
                  <div className="min-w-0">
                    <strong>This console is running older code than is on disk.</strong> Node loads the server
                    once, at startup — the page reloads from disk but the process cannot. Restart it, or a fix
                    you already have will look like it did not work.
                  </div>
                </Banner>
              )}
              {/* A console you stopped on purpose outranks every other reading
                  of a dead stream: "Reconnecting…" would be a promise nothing
                  is going to keep. */}
              {stopped ? (
                <Banner severity="warn">
                  <Power size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <strong>
                      {sse === 'live' ? 'This console is shutting down.' : 'This console is off.'}
                    </strong>{' '}
                    {stopped.via === 'launchctl'
                      ? 'Its launchd job was unloaded, so nothing will bring it back.'
                      : 'The process has ended.'}{' '}
                    Start it again with <code className="font-mono text-2xs">{stopped.hint}</code>.
                  </div>
                </Banner>
              ) : (
                (!online || sse !== 'live') && (
                  <Banner severity={!online || sse === 'offline' ? 'error' : 'info'}>
                    <WifiOff size={15} className="mt-0.5 shrink-0" aria-hidden />
                    <div className="min-w-0">
                      {/* Being offline outranks whatever the stream thinks: it
                        explains the stream, and it is the one the reader can
                        actually do something about. */}
                      {!online
                        ? 'This device is offline. Everything below was loaded before that and is no longer updating.'
                        : sse === 'offline'
                          ? 'Live updates stopped. Reload to reconnect.'
                          : 'Reconnecting to the console — the board may be a moment behind.'}
                    </div>
                  </Banner>
                )
              )}
            </div>
          )}

          <Suspense
            fallback={
              <div className="grid place-items-center py-16">
                <Spinner />
              </div>
            }
          >
            {FULL_HEIGHT_HEADS.has(head ?? '') ? (
              <div className="min-h-0 flex-1">
                <View route={route} />
              </div>
            ) : (
              <View route={route} />
            )}
          </Suspense>
        </main>

        {/* Hidden while a text field has focus on touch: typing is never a
            navigation moment, and those 60px keep the terminal's prompt and
            KeyBar visible above the software keyboard. */}
        {phone && !keyboardOpen && (
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
