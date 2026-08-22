import { Suspense, useEffect, useRef } from 'react';
import { Power, WifiOff } from 'lucide-react';
import { useOnline, useServiceWorker } from '@/lib/pwa';
import { usePhone } from '@/lib/media';
import { onSse, useSseStatus } from '@/lib/sse';
import { useConsoleStopped } from '@/lib/shutdown';
import {
  shellCounts,
  useAttentionInbox,
  useApprovals,
  useConsoleState,
  useLiveData,
  useMcp,
  usePlans,
  useSessions,
} from '@/lib/queries';
import { Banner, Spinner, Toaster, TooltipProvider, toast } from '@/components/ui';
import { installAppHeight } from '@/lib/viewport';
import { resolveView, useNavigate, useRoute } from '@/app/router';
import { CHROMELESS_HEADS, FULL_HEIGHT_HEADS, redirectTarget } from '@/app/routes';
import { RouteFrame } from '@/app/shell/route-frame';
import { ShellLayout } from '@/app/shell/layout';
import { Palette } from '@/app/command/palette';
import { NotificationsDrawer } from '@/app/notifications/drawer';
import { HelpSheet } from '@/app/help/sheet';
import { Disconnected } from '@/app/shell/disconnected';

/**
 * The composition root.
 *
 * Everything that used to be *in* here is somewhere better now: the grid, the
 * rail, the tab bar and the one scroller are `app/shell/layout.tsx`; the route
 * table is `app/router.tsx`; the keyboard shortcuts belong to the palette that
 * implements them. What is left is the four things only a root can do — mount
 * the live data once, decide whether there is a console to talk to at all,
 * follow a redirect, and hang the three overlays where every page can reach them.
 */

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
  const navigate = useNavigate();
  const head = route.segments[0];
  const phone = usePhone();
  const sse = useSseStatus();
  const online = useOnline();
  const stopped = useConsoleStopped();

  // Every server event, wired to what it makes stale. Mounted once, here.
  useLiveData();
  // `--app-height` follows the visual viewport (the keyboard, mostly) — the
  // shell's height token. Once, for the app's life.
  useEffect(() => installAppHeight(), []);
  // Registers the worker and offers an update when one is waiting. Also once.
  useServiceWorker();
  // The recovery verdict, said where the person is looking. The notification
  // leg announces it too; this is the in-page echo of the same event the run
  // queries re-read themselves off (`patchSessions`).
  useRecoveryOutcomeToasts();

  // An alias resolves before anything renders, and it REPLACES rather than
  // pushes: `#/dashboard` in the history is a bookmark someone followed, not a
  // page they should have to press Back through twice to leave.
  const target = redirectTarget(route);
  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [target, navigate]);

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
  // rather than something the Sessions page knows while you are on it.
  const { data: sessions } = useSessions(state);
  const { data: mcp } = useMcp();
  // The badge's own source since Phase 8: one deduped list of everything that
  // needs a person, rather than the approvals count standing in for it. Held
  // at the SHELL because the number is on the rail and the tab bar, which are
  // on screen whatever page you are on — and because the bell drawer renders
  // the same rows over any of them.
  const { data: inbox } = useAttentionInbox(false, Boolean(state) && state?.autopilot !== false);

  const counts = shellCounts(
    plans,
    approvals,
    state?.unread ?? 0,
    sessions?.sessions,
    mcp?.servers,
    inbox?.items,
  );

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

  // Mid-redirect: the effect above has fired and the hash is about to change.
  // Rendering the alias's (nonexistent) page for one frame would flash the
  // fallback at everyone who followed an old link.
  if (target) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }

  // The help sheet is what you read before you have set anything up, so an
  // unconfigured console still opens it rather than sending you to the picker.
  const askingForHelp = route.query.help != null;
  const needsSource = (!rootOk || CHROMELESS_HEADS.has(head ?? '')) && !askingForHelp;

  if (needsSource) {
    const SourceView = resolveView('source')!;
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

  const View = resolveView(head)!;
  const fullHeight = FULL_HEIGHT_HEADS.has(head ?? '');

  return (
    <TooltipProvider delayDuration={300}>
      <ShellLayout
        state={state}
        counts={counts}
        route={route}
        phone={phone}
        banners={
          (state.serverStale || stopped || !online || sse !== 'live') && (
            <>
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
            </>
          )
        }
      >
        <RouteFrame view={View} route={route} fullHeight={fullHeight} />
      </ShellLayout>

      {/* The three overlays. Each is open exactly when the URL says so, which is
          why none of them needs the shell to hold a flag for it. */}
      <Palette route={route} state={state} counts={counts} />
      <NotificationsDrawer route={route} />
      <HelpSheet route={route} />

      <Toaster />
    </TooltipProvider>
  );
}
