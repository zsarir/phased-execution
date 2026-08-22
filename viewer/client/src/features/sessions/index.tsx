/**
 * **Sessions** — one place for every process this console owns or can see.
 *
 * Phase 3 made Sessions a destination with a placeholder that linked to the two
 * pages doing the work; this is the page it was a placeholder for. Four lists
 * became one (`list.tsx` explains the fold), and `#/terminal/:id` and
 * `#/agent/:id` became `#/sessions/:id` — one address whose kind is read off
 * the record rather than out of the URL.
 *
 * ## Two shapes, one route
 *
 * `#/sessions` is the LIST: every lane, agent session, shell and foreign
 * process, grouped, with the two New buttons. `#/sessions/:id` (and
 * `?new=agent`, the launcher) is the PANE, with the list collapsed to a strip
 * above it — beside it on a desktop, above it on a phone. Splitting them by
 * route rather than by breakpoint is what lets a phone deep-link straight into
 * a terminal without first painting a list it has to scroll past.
 *
 * ## Why the lane rows do not fan out plan details
 *
 * `nowLanes` takes an optional per-plan detail map and uses it for the plan's
 * TITLE and the phase's ETA. Now fetches those because it already holds them
 * for four other bands; this page would be issuing one `GET /api/plan/:slug`
 * per live run purely to turn a slug into a title. The row says the slug and
 * links to the run page, where the title, the ETA and the console all live.
 */

import { useMemo } from 'react';
import { Bot, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { usePhone } from '@/lib/media';
import { estimateTerminalSize } from '@/lib/terminal';
import { keys, useConsoleState, useRuns, useSessionRegistry, useTerminals } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import { nowLanes } from '@/features/now/model';
import { navigate, type Route } from '@/app/router';
import { Button, Empty, toast } from '@/components/ui';
import { Page } from '@/components/page';
import { SessionList, sessionRows } from './list';
import SessionPage from './session-page';

/** `?new=` — the only two things a person can start from here. */
function startingOf(route: Route): 'agent' | 'shell' | undefined {
  const value = route.query.new;
  return value === 'agent' || value === 'shell' ? value : undefined;
}

export default function SessionsView({ route }: { route: Route }) {
  const sessionId = route.segments[1];
  const starting = startingOf(route);

  const { data: state } = useConsoleState();
  const allowAgent = state?.allowAgent === true;
  const allowTerminal = state?.allowTerminal === true;

  // The same stale-server guard every run-reading surface uses: `/api/state`
  // has to have answered before the run endpoints are asked, or a console whose
  // server predates the autopilot fills the browser log with 404s.
  const runsEnabled = state != null && state.autopilot !== false;
  const { data: runs } = useRuns(runsEnabled);
  const { data: registry } = useSessionRegistry();
  const { data: terminals } = useTerminals(allowAgent || allowTerminal);

  const lanes = useMemo(() => nowLanes(runs ?? []), [runs]);
  const rows = useMemo(
    () => sessionRows({ terminals: terminals?.sessions, lanes, foreign: registry?.sessions }),
    [terminals, lanes, registry],
  );
  /** Everything this console cannot open a pane for — the strip's sheet extra. */
  const elsewhere = useMemo(
    () => rows.filter((row) => row.kind === 'lane' || row.kind === 'foreign'),
    [rows],
  );

  if (sessionId || starting) {
    return (
      <SessionPage
        route={route}
        sessionId={sessionId}
        starting={starting}
        extra={elsewhere.length > 0 ? <SessionList rows={elsewhere} /> : undefined}
      />
    );
  }

  return <SessionsList rows={rows} allowAgent={allowAgent} allowTerminal={allowTerminal} />;
}

/* ---------------- `#/sessions` — the list ---------------- */

function SessionsList({
  rows,
  allowAgent,
  allowTerminal,
}: {
  rows: ReturnType<typeof sessionRows>;
  allowAgent: boolean;
  allowTerminal: boolean;
}) {
  const client = useQueryClient();
  const phone = usePhone();

  /**
   * A shell is one POST — there is no form to fill in, so the button starts it
   * and navigates. An agent session has choices that must exist before the pty
   * does (model, effort, permissions, the first prompt), so its button goes to
   * `?new=agent` and RunSetup collects them.
   */
  async function openShell() {
    try {
      const ticket = await api.terminalTicket(estimateTerminalSize(phone));
      if (ticket.session) {
        client.setQueryData(keys.terminal(), (prev: { sessions: unknown[] } | undefined) =>
          prev ? { ...prev, available: 'yes' as const, sessions: [...prev.sessions, ticket.session] } : prev,
        );
      }
      void client.invalidateQueries({ queryKey: keys.terminal() });
      navigate(`sessions/${ticket.sessionId}`);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <Page
        title="Sessions"
        subtitle="Every process this console owns or can see — the lanes it runs, the sessions you open, and the Claude sessions the presence hook reports on this machine."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {allowAgent && (
              <Button size="sm" onClick={() => navigate('sessions?new=agent')}>
                <Bot size={14} aria-hidden /> New session
              </Button>
            )}
            {allowTerminal && (
              <Button size="sm" variant="ghost" onClick={() => void openShell()}>
                <Plus size={14} aria-hidden /> New shell
              </Button>
            )}
          </div>
        }
      >
        <SessionList
          rows={rows}
          empty={
            <Empty
              title="Nothing is running"
              body={
                allowAgent || allowTerminal
                  ? 'No lane, no session of your own, and no other Claude the presence hook can see. Start one above.'
                  : 'This console was started without --allow-agent and without --allow-terminal, so it opens no sessions of its own. Autopilot lanes still run and still appear here.'
              }
            />
          }
        />
      </Page>
    </div>
  );
}
