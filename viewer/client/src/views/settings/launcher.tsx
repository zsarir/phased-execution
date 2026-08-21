/**
 * The Desktop launcher card.
 *
 * It sits next to *This process* because that is where the question arrives:
 * the Restart button refuses when nothing is supervising this console, and the
 * refusal explains the cause without giving you a way to fix it. The Create
 * button answers it directly: the server writes the launcher itself, with this
 * console's root and port baked in and every capability switch on. The paste-
 * into-Claude walkthrough for the same act lives in the guide and the README
 * (`shared/setup-prompts.js`), not here — a page with a working button does
 * not also need the manual procedure beside it.
 */

import { useState } from 'react';
import { SETUP_PROMPTS } from '@shared/setup-prompts.js';
import { api } from '@/lib/api';
import { useConsoleState, useLauncherPlan } from '@/lib/queries';
import { Banner, Button, Card, CardBody, CardHeader, CardTitle, toast } from '@/components/ui';

export function LauncherCard({ supervised }: { supervised?: boolean }) {
  const setup = SETUP_PROMPTS.find((p) => p.id === 'desktop-launcher');
  const { data: plan } = useLauncherPlan();
  const { data: state } = useConsoleState();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ path: string; note: string } | null>(null);
  if (!setup) return null;

  // "$HOME/…" in the shown path, same rule as the start-command card: portable
  // to read, no username in a screenshot.
  const shownPath =
    plan?.path && state?.home && plan.path.startsWith(`${state.home}/`)
      ? `~${plan.path.slice(state.home.length)}`
      : plan?.path;

  const create = () => {
    setCreating(true);
    api
      .createLauncher()
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
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {/* The server writes the launcher itself — this console's root and
            port baked in, all five switches on. */}
        {plan?.supported ? (
          <div className="flex flex-col gap-2 rounded border border-rule bg-ground-deep p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="action"
                disabled={creating || !plan.rootOpen || state?.allowWrites !== true}
                title={
                  state?.allowWrites !== true
                    ? 'Restart with --allow-writes — writing an executable to the Desktop is a write.'
                    : plan.rootOpen
                      ? `Writes ${shownPath ?? 'the launcher'} with this console's source directory, port, every capability switch, and its remote/session/skills settings.`
                      : 'Open a source directory first — the launcher bakes it in as its ROOT.'
                }
                onClick={create}
              >
                {creating ? 'Writing…' : 'Create the Desktop launcher — full options'}
              </Button>
              {shownPath ? <code className="text-2xs text-ink-faint">{shownPath}</code> : null}
            </div>
            <p className="m-0 text-2xs text-ink-faint">
              {plan.platform === 'darwin' ? (
                <>
                  macOS: a double-clickable .command with ROOT, PORT,{' '}
                  {(plan.fullFlags ?? []).map((flag) => (
                    <code key={flag} className="mr-1">
                      {flag}
                    </code>
                  ))}
                  and this console&rsquo;s remote/session/skills settings baked in.
                </>
              ) : (
                'Linux: an XDG .desktop entry that runs the start command — full flag set — in a terminal.'
              )}{' '}
              {created ? created.note : plan.note}
            </p>
            {created ? (
              <p className="m-0 text-2xs text-ink-muted">
                Written to <code>{created.path}</code>.
              </p>
            ) : null}
          </div>
        ) : plan ? (
          <Banner severity="info">{plan.note}</Banner>
        ) : null}

        <p className="text-sm text-ink-muted">{setup.lede}</p>

        {supervised === false && (
          <Banner severity="warn">
            Nothing is supervising this console, which is why Restart refuses above. A launcher started with{' '}
            <code>SUPERVISED="yes"</code> installs a launchd agent — and a clean exit comes straight back, so
            the button has something to restart.
          </Banner>
        )}
      </CardBody>
    </Card>
  );
}
