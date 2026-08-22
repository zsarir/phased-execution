import { Bot, TerminalSquare } from 'lucide-react';
import { useConsoleState } from '@/lib/queries';
import { Banner, Card, Empty } from '@/components/ui';
import { Page } from '@/components/page';

/**
 * **Sessions** — the destination, before the page.
 *
 * Sessions is one of the six from Phase 3 because the *navigation* is what this
 * phase is for: `#/agent/:id` and `#/terminal/:id` light this entry up, the tab
 * bar has its slot, and a push notification about a session that ended has a
 * destination that exists. The page itself — one list and one pane for lanes,
 * agent sessions, shells and foreign processes, with the phone terminal rebuilt
 * on Phase 1's mechanism — is Phase 10.
 *
 * So this links to the two pages that do the work today rather than pretending
 * to be them. A placeholder that lies about what it can do is worse than the
 * two-tap detour it was trying to save.
 */
export default function SessionsView() {
  const { data: state } = useConsoleState();
  const agent = state?.allowAgent === true;
  const terminal = state?.allowTerminal === true;

  return (
    <Page
      title="Sessions"
      subtitle="Every process this console owns or can see — the lanes it runs, the agent sessions you open, and the shells on this machine."
    >
      <Banner severity="info">
        <div className="min-w-0">
          <strong>One sessions view lands in Phase 10.</strong> Until then the two pages below are unchanged —
          including the phone terminal fixed in Phase 1, whose key bar, first-attach size and auto-reconnect
          this page inherits when it is rebuilt.
        </div>
      </Banner>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <SessionLink
          href="#/agent"
          icon={Bot}
          title="Agent sessions"
          body="Interactive Claude sessions in a terminal, with the launcher and the plan wizard."
          enabled={agent}
          flag="--allow-agent"
        />
        <SessionLink
          href="#/terminal"
          icon={TerminalSquare}
          title="Terminal"
          body="A shell on this machine, from here or from a phone."
          enabled={terminal}
          flag="--allow-terminal"
        />
      </div>

      {!agent && !terminal && (
        <div className="mt-4">
          <Empty
            title="This console starts no sessions of its own"
            body="It was started without --allow-agent and without --allow-terminal, so both pages will explain themselves rather than open anything. Autopilot lanes still run and still appear on a plan's run page."
          />
        </div>
      )}
    </Page>
  );
}

function SessionLink({
  href,
  icon: Icon,
  title,
  body,
  enabled,
  flag,
}: {
  href: string;
  icon: typeof Bot;
  title: string;
  body: string;
  enabled: boolean;
  flag: string;
}) {
  return (
    <Card>
      <a
        href={href}
        className="flex min-h-(--tap-min) items-start gap-3 p-3 hover:bg-surface-raised focus-visible:bg-surface-raised"
      >
        <Icon size={18} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />
        <span className="min-w-0">
          <strong className="block">{title}</strong>
          <span className="mt-0.5 block text-sm text-ink-muted">{body}</span>
          {!enabled && (
            <span className="mt-1.5 block text-2xs text-ink-faint">
              Off on this console — start it with <code className="font-mono">{flag}</code>.
            </span>
          )}
        </span>
      </a>
    </Card>
  );
}
