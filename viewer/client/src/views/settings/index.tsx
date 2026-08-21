/**
 * Settings, and what the console is reading.
 *
 * Ported from `web/views/settings.js` with one addition the rewrite made
 * necessary: **which client this server is serving**. The static root is picked
 * per request — `client/dist` when a build exists, else the legacy `web/` — so
 * during the migration a long-lived console can change what it serves without
 * restarting, and "am I looking at the new client or the old one" stopped being
 * answerable from the page itself. Now it is a fact on this screen.
 */

import { usePrefs, type Theme } from '@/lib/prefs';
import { useConsoleState } from '@/lib/queries';
import { weight } from '@/lib/format';
import { navigate } from '@/router';
import {
  Banner, Button, ButtonGroup, Card, CardBody, CardHeader, CardTitle, KeyValue, Skeleton, toast,
} from '@/components/ui';
import { useState } from 'react';
import { applyUpdateNow } from '@/lib/pwa';
import { Page } from '../_page';
import { AutomationCard } from './automation';
import { SessionHookCard } from './hooks';
import { AccountsCard } from './accounts';
import { McpCard } from './mcp';
import { StartCommandCard } from './start-command';
import { PolicyCard } from './policy';
import { RestartButton } from './restart';
import { ShutdownButton } from './shutdown';
import { LauncherCard } from './launcher';
import { TailscaleCard } from './tailscale';

const MODELS = ['', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'];

const THEMES: [Theme, string][] = [['system', 'Auto'], ['dark', 'Night'], ['light', 'Paper']];

export default function SettingsView() {
  const { data: state } = useConsoleState();
  const [prefs, setPrefs] = usePrefs();

  if (!state) {
    return (
      <Page title="Settings">
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      </Page>
    );
  }

  const repo = state.repo;
  const dirty = repo?.dirty ?? [];

  return (
    <Page title="Settings" subtitle="Phase Console">
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Notifications</CardTitle>
            <Button size="sm" onClick={() => navigate('notifications/settings')}>Open</Button>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <p className="text-sm text-ink-muted">
              Which categories the console announces at all, the devices a push reaches, and the
              delivery test live on their own page — beside the inbox of everything the console has
              announced, including the ones that arrived while nothing was open to hear them.
            </p>
            <p className="text-sm text-ink-muted">
              Switching a category off there silences it everywhere: no inbox record, no open tab,
              no device, and no <code>PHASE_CONSOLE_NOTIFY</code>. That command is run with the
              title and body of everything that is <em>not</em> silenced, for a machine with no
              browser in the picture at all.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>This process</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-3">
            <KeyValue
              items={[
                ['Server code', state.serverStale
                  ? <span className="text-action">older than what is on disk</span>
                  : 'current with what is on disk'],
                // Reported rather than inferred — the pick is per request, so
                // a build cuts a live console over with no restart. `not-built`
                // is reachable from here: a precached shell keeps running after
                // `client/dist` is deleted, and this row is how it says so.
                ['Serving', state.staticRoot === 'dist'
                  ? <span>the built client (<code>client/dist</code>)</span>
                  : state.staticRoot === 'not-built'
                    ? <span>nothing — <code>client/dist</code> is missing; run <code>npm run build</code></span>
                    : 'unknown — this server predates the static-root report'],
                // THIS TAB against the server's build — the diagnostic for
                // "I deployed and still see the old app": the service worker
                // keeps a cached shell until an update applies, and this row is
                // where that mismatch stops being invisible.
                ['Interface', interfaceRow(state.distRev)],
                ['Supervisor', state.supervisor?.detail ?? 'unknown'],
              ]}
            />
            <RestartButton />
            <p className="text-2xs text-ink-faint">
              Node reads <code>server/</code> once, at startup. Reloading the page reloads the
              client and nothing else, so a server fix you already have looks like it did not work
              until this process is replaced.
            </p>
            <div className="border-t border-rule pt-3">
              <UpdateInterfaceButton />
              <p className="mt-2 text-2xs text-ink-faint">
                The other half of the same coin: restarting the SERVER does not update open
                tabs. The interface is cached by a service worker and swaps only when you
                approve — usually via the &ldquo;new version&rdquo; toast. If that toast is
                gone, this pulls the newest build into this tab now.
              </p>
            </div>
            <div className="border-t border-rule pt-3">
              <ShutdownButton />
            </div>
          </CardBody>
        </Card>

        {/* Directly after *This process*: that card is where Restart refuses,
            and this is the fix for the reason it refuses. */}
        <StartCommandCard />

        <LauncherCard supervised={state.supervisor?.supervised} />

        {/* Between *This process* and *Source*: how this console is reached and
            by whom belongs with the process, not with the repo it reads. */}
        <TailscaleCard
          port={state.port ?? 4123}
          remoteHosts={state.remoteHosts}
          remoteUsers={state.remoteUsers}
        />

        <Card>
          <CardHeader>
            <CardTitle>Source</CardTitle>
            <Button size="sm" onClick={() => navigate('source')}>Change</Button>
          </CardHeader>
          <CardBody>
            <KeyValue
              items={[
                ['Directory', <code>{state.root?.path}</code>],
                ['Plans', `${state.root?.planCount ?? 0} files in docs/plans`],
                ['Handoff folders', String(state.root?.handoffCount ?? 0)],
                ['Repository', repo?.available
                  ? `${repo.branch}${repo.ahead ? ` · ${repo.ahead} ahead` : ''}${repo.behind ? ` · ${repo.behind} behind` : ''}`
                  : 'not a git repository'],
                ['Uncommitted under docs/', dirty.length
                  ? (
                    <span className="font-mono text-2xs">
                      {dirty.slice(0, 6).join(', ')}
                      {dirty.length > 6 ? ` +${dirty.length - 6}` : ''}
                    </span>
                  )
                  : 'none'],
                ['Indexed sections', String(state.searchDocs ?? 0)],
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>Engine</CardTitle></CardHeader>
          <CardBody>
            <KeyValue
              items={[
                ['Scripts', <code>{state.scriptsDir}</code>],
                ['Writes', state.allowWrites
                  ? 'enabled — scaffolds, QA records and locks'
                  : <span>read-only · restart with <code>--allow-writes</code></span>],
                ['Phase weights',
                  `S ${weight(state.sizing?.S)} · M ${weight(state.sizing?.M)} · L ${weight(state.sizing?.L)}`],
                ['Session budgets',
                  `1M-class ${weight(state.sizing?.budgetBig)} · 200K-class ${weight(state.sizing?.budgetHaiku)}`],
              ]}
            />
            <p className="mt-3 text-2xs text-ink-faint">
              Status, session batches, boot prompts and lint always come from these scripts. The
              console parses the markdown only for the parts they do not expose.
            </p>
          </CardBody>
        </Card>

        <AutomationCard />

        {/* Beside Automation: the hook is what lets the autopilot see the
            sessions it shares the repository with. */}
        <SessionHookCard />

        <AccountsCard />

        <McpCard />

        <Card>
          <CardHeader><CardTitle>Appearance</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-ink">Theme</span>
              <ButtonGroup>
                {THEMES.map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    aria-pressed={prefs.theme === value}
                    onClick={() => setPrefs({ theme: value })}
                  >
                    {label}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-ink">Show documents in the plan list</span>
              <Button
                size="sm"
                aria-pressed={prefs.showDocuments}
                onClick={() => setPrefs({ showDocuments: !prefs.showDocuments })}
              >
                {prefs.showDocuments ? 'Shown' : 'Hidden'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="session-model" className="text-sm text-ink">Session plan model</label>
              <select
                id="session-model"
                value={prefs.model}
                onChange={(event) => setPrefs({ model: event.target.value })}
                className="min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-sm text-ink"
              >
                {MODELS.map((model) => (
                  <option key={model} value={model}>{model || "each plan's own target"}</option>
                ))}
              </select>
            </div>
          </CardBody>
        </Card>

        <PolicyCard allowWrites={Boolean(state.allowWrites)} />

        <Card>
          <CardHeader><CardTitle>Keyboard</CardTitle></CardHeader>
          <CardBody>
            {/* Kept in step with `SHORTCUTS` in App.tsx — the shell grew three
                the legacy list never had. */}
            <KeyValue
              items={[
                ['/', 'search'],
                ['r', 'ready now'],
                ['p', 'plans'],
                ['d', 'dashboard'],
                ['s', 'statistics'],
                ['g', 'guide'],
                ['n', 'notifications'],
                ['Esc', 'close a dialog'],
              ]}
            />
          </CardBody>
        </Card>
      </div>

      {state.serverStale && (
        <Banner severity="warn" className="mt-3">
          The server files on disk are newer than this process. Restart it above to run them.
        </Banner>
      )}
    </Page>
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
 * this replaces the BUNDLE THIS TAB RUNS — the half a service-worker app
 * hides, and the half "I restarted and it still looks old" is actually about.
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
            toast('No service worker here (dev server, or an unsupported browser) — a plain reload already gets the newest build.', 'info');
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
