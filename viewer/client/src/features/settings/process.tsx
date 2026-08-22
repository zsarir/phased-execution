/**
 * This process — what is running, how it was started, how it is reached, and
 * how to replace it.
 *
 * Four cards that were four separate places in 2.x and are one question. The
 * order is the order the answers are needed: what this process IS, then the
 * command that Restart refuses without, then who may launch a session on it,
 * then how it is reached from anywhere else.
 *
 * The two replace buttons are deliberately on the same screen and deliberately
 * distinct: **Restart** replaces the SERVER (Node reads `server/` once, at
 * startup) and **Get the latest interface** replaces the BUNDLE THIS TAB RUNS
 * (a service worker keeps a cached shell until an update applies). "I deployed
 * and still see the old app" is always one of those two, and a page that
 * offered only one made the other invisible.
 */

import { useState } from 'react';
import { useConsoleState } from '@/lib/queries';
import { applyUpdateNow } from '@/lib/pwa';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  KeyValue,
  Skeleton,
  toast,
} from '@/components/ui';
import { SettingsSectionFrame, sectionFor } from './nav';
import { RestartButton } from './restart';
import { ShutdownButton } from './shutdown';
import { StartCommandCard } from './start-command';
import { LauncherCard } from './launcher';
import { TailscaleCard } from './tailscale';

export function ProcessSection() {
  const { data: state } = useConsoleState();
  const section = sectionFor('process')!;

  if (!state) {
    return (
      <SettingsSectionFrame section={section}>
        <Skeleton className="h-56" />
        <Skeleton className="h-40" />
      </SettingsSectionFrame>
    );
  }

  return (
    <SettingsSectionFrame section={section}>
      {state.serverStale && (
        <Banner severity="warn">
          The server files on disk are newer than this process. Restart it below to run them.
        </Banner>
      )}

      <Card>
        <CardHeader>
          <CardTitle>This process</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <KeyValue
            items={[
              [
                'Server code',
                state.serverStale ? (
                  <span key="s" className="text-action">
                    older than what is on disk
                  </span>
                ) : (
                  'current with what is on disk'
                ),
              ],
              // Reported rather than inferred — the pick is per request, so a
              // build cuts a live console over with no restart. `not-built` is
              // reachable from here: a precached shell keeps running after
              // `client/dist` is deleted, and this row is how it says so.
              [
                'Serving',
                state.staticRoot === 'dist' ? (
                  <span key="d">
                    the built client (<code>client/dist</code>)
                  </span>
                ) : state.staticRoot === 'not-built' ? (
                  <span key="n">
                    nothing — <code>client/dist</code> is missing; run <code>npm run build</code>
                  </span>
                ) : (
                  'unknown — this server predates the static-root report'
                ),
              ],
              // THIS TAB against the server's build — the diagnostic for "I
              // deployed and still see the old app".
              ['Interface', interfaceRow(state.distRev)],
              ['Supervisor', state.supervisor?.detail ?? 'unknown'],
            ]}
          />
          <RestartButton />
          <p className="text-2xs text-ink-faint">
            Node reads <code>server/</code> once, at startup. Reloading the page reloads the client and
            nothing else, so a server fix you already have looks like it did not work until this process is
            replaced.
          </p>
          <div className="border-t border-rule pt-3">
            <UpdateInterfaceButton />
            <p className="mt-2 text-2xs text-ink-faint">
              The other half of the same coin: restarting the SERVER does not update open tabs. The interface
              is cached by a service worker and swaps only when you approve — usually via the &ldquo;new
              version&rdquo; toast. If that toast is gone, this pulls the newest build into this tab now.
            </p>
          </div>
          <div className="border-t border-rule pt-3">
            <ShutdownButton />
          </div>
        </CardBody>
      </Card>

      {/* Directly after *This process*: that card is where Restart refuses, and
          this is the fix for the reason it refuses. */}
      <StartCommandCard />

      <LauncherCard supervised={state.supervisor?.supervised} />

      <TailscaleCard
        port={state.port ?? 4123}
        remoteHosts={state.remoteHosts}
        remoteUsers={state.remoteUsers}
      />
    </SettingsSectionFrame>
  );
}

/**
 * THIS TAB's build against the server's — the words for the Interface row.
 *
 * `__BUILD_REV__` is baked by Vite from the same function that stamps
 * `dist/.build-rev`, so equal strings mean "the page you are reading is the
 * page this server serves". Either side unknowable degrades to saying so.
 */
function interfaceRow(distRev: string | null | undefined): React.ReactNode {
  const mine = typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'unknown';
  if (!distRev || distRev === 'unknown' || mine === 'unknown') {
    return 'unknown (an unstamped build, or a server that predates the report)';
  }
  if (mine === distRev) return `current with the server's build (${mine.slice(0, 12)})`;
  return (
    <span className="text-action">
      this tab was built from <code>{mine.slice(0, 12)}</code>; the server now serves{' '}
      <code>{distRev.slice(0, 12)}</code> — use &ldquo;Get the latest interface&rdquo; below
    </span>
  );
}

/**
 * The client-side twin of Restart. The server button replaces the PROCESS;
 * this replaces the BUNDLE THIS TAB RUNS — the half a service-worker app hides,
 * and the half "I restarted and it still looks old" is actually about.
 */
function UpdateInterfaceButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void applyUpdateNow().then((result) => {
          if (result === 'current') {
            toast('This tab already runs the newest interface.', 'ok');
            setBusy(false);
          } else if (result === 'unsupported') {
            toast(
              'No service worker here (dev server, or an unsupported browser) — a plain reload already gets the newest build.',
              'info',
            );
            setBusy(false);
          }
          // 'reloading' needs nothing: the page is replacing itself.
        });
      }}
    >
      {busy ? 'Checking…' : 'Get the latest interface'}
    </Button>
  );
}
