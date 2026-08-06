/**
 * The Desktop launcher card.
 *
 * It sits next to *This process* because that is where the question arrives:
 * the Restart button refuses when nothing is supervising this console, and the
 * refusal explains the cause without giving you a way to fix it. A person
 * reading "install it as an agent (deploy/agent.sh install)" still has to find
 * the directory, decide the flags, and know that the Desktop file is a copy
 * that will not update itself. This hands all of that to Claude instead.
 *
 * The text comes from `shared/setup-prompts.js` — the same string the guide and
 * the README carry, asserted verbatim by a test, because three hand-maintained
 * copies of an install procedure disagree within a release.
 */

import { useState } from 'react';
import { SETUP_PROMPTS } from '@shared/setup-prompts.js';
import { api } from '@/lib/api';
import { useConsoleState, useLauncherPlan } from '@/lib/queries';
import { Banner, Button, Card, CardBody, CardHeader, CardTitle, CopyButton, toast } from '@/components/ui';

export function LauncherCard({ supervised }: { supervised?: boolean }) {
  const setup = SETUP_PROMPTS.find((p) => p.id === 'desktop-launcher');
  const { data: plan } = useLauncherPlan();
  const { data: state } = useConsoleState();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ path: string; note: string } | null>(null);
  if (!setup) return null;

  // "$HOME/…" in the shown path, same rule as the start-command card: portable
  // to read, no username in a screenshot.
  const shownPath = plan?.path && state?.home && plan.path.startsWith(`${state.home}/`)
    ? `~${plan.path.slice(state.home.length)}`
    : plan?.path;

  const create = () => {
    setCreating(true);
    api.createLauncher()
      .then((outcome) => {
        setCreated({ path: outcome.path, note: outcome.note });
        toast('Desktop launcher written — every capability on.', 'ok');
      })
      .catch((error: Error) => toast(String(error.message ?? error), 'error'))
      .finally(() => setCreating(false));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{setup.title}</CardTitle>
        <CopyButton text={setup.prompt} label="Copy prompt" />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {/* The one-click path first: the server writes the launcher itself —
            this console's root and port baked in, all five switches on. The
            AI prompt below stays for machines where the file needs judgment
            (a different root, hand-carried plist flags). */}
        {plan?.supported ? (
          <div className="flex flex-col gap-2 rounded border border-rule bg-ground-deep p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="action"
                disabled={creating || !plan.rootOpen}
                title={plan.rootOpen
                  ? `Writes ${shownPath ?? 'the launcher'} with this console's source directory and port, and every capability switch on.`
                  : 'Open a source directory first — the launcher bakes it in as its ROOT.'}
                onClick={create}
              >
                {creating ? 'Writing…' : 'Create the Desktop launcher — full options'}
              </Button>
              {shownPath ? <code className="text-2xs text-ink-faint">{shownPath}</code> : null}
            </div>
            <p className="m-0 text-2xs text-ink-faint">
              {plan.platform === 'darwin'
                ? 'macOS: a double-clickable .command with ROOT, PORT and all five --allow switches set.'
                : 'Linux: an XDG .desktop entry that runs the start command in a terminal.'}{' '}
              {created ? created.note : plan.note}
            </p>
            {created ? (
              <p className="m-0 text-2xs text-ink-muted">Written to <code>{created.path}</code>.</p>
            ) : null}
          </div>
        ) : plan ? (
          <Banner severity="info">{plan.note}</Banner>
        ) : null}

        <p className="text-sm text-ink-muted">{setup.lede}</p>

        {supervised === false && (
          <Banner severity="warn">
            Nothing is supervising this console, which is why Restart refuses above. A launcher
            started with <code>SUPERVISED="yes"</code> installs a launchd agent — and a clean exit
            comes straight back, so the button has something to restart.
          </Banner>
        )}

        <p className="text-sm text-ink-muted">
          Paste this into Claude Code. It asks before it changes anything, and it deliberately does
          not run the launcher for you — the first run can install a background agent that starts at
          login.
        </p>

        <pre className="m-0 max-h-96 overflow-auto overscroll-contain rounded bg-ground-deep p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {setup.prompt}
        </pre>
      </CardBody>
    </Card>
  );
}
