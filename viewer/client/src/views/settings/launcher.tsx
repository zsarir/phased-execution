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

import { SETUP_PROMPTS } from '@shared/setup-prompts.js';
import { Banner, Card, CardBody, CardHeader, CardTitle, CopyButton } from '@/components/ui';

export function LauncherCard({ supervised }: { supervised?: boolean }) {
  const setup = SETUP_PROMPTS.find((p) => p.id === 'desktop-launcher');
  if (!setup) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{setup.title}</CardTitle>
        <CopyButton text={setup.prompt} label="Copy prompt" />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
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
