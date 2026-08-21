import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  StateChip,
  Table,
  TableWrap,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { RouteMap } from '@/components/dag';
import { PromptCard } from '@/components/prompt-card';
import { RouteCards } from './route-cards';
import { api } from '@/lib/api';
import { isClosed } from '@/lib/closure';
import { keys } from '@/lib/queries';
import { pad2, weight } from '@/lib/format';
import { navigate, phaseHref } from '@shared/routes.js';
import type { PlanDetail } from '@/lib/api';
import { DepsCell, FlagsCell, LockCell, ScopeCell, SizeCell, TitleCell } from './phase-cells';
import { usePhone } from '@/lib/media';
import { PhasesTab as PhonePhaseList } from './phases-tab';

/** The estimate for one phase, or nothing on a source with no plan detail. */
const etaFor = (detail: PlanDetail, phase: number) => detail.eta?.perPhase.find((e) => e.phase === phase);

/**
 * The departures board.
 *
 * Every row is a link. The old client made the whole `<tr>` clickable with an
 * `onClick` and no tabindex, so the board was navigable with a mouse and with
 * nothing else — no keyboard, no screen reader, no open-in-new-tab. The phase
 * number is the real anchor and its `::after` covers the row, which keeps one
 * focusable element per row instead of six.
 */
function DeparturesBoard({ detail }: { detail: PlanDetail }) {
  const slug = detail.summary.slug;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Departures</CardTitle>
        <span className="text-xs text-ink-faint">
          {detail.phases.length} phases · open a row for the full phase
        </span>
      </CardHeader>
      <TableWrap className="rounded-none border-0 border-t border-rule">
        <Table>
          <THead>
            <TR>
              <TH className="w-14">#</TH>
              <TH>Phase</TH>
              <TH className="w-24">Status</TH>
              <TH className="w-40">Deps</TH>
              <TH className="w-40">Lock</TH>
              <TH className="w-14">Size</TH>
              <TH className="w-36">Repos</TH>
              <TH className="w-40">Notes</TH>
            </TR>
          </THead>
          <TBody>
            {detail.phases.map((phase) => (
              <TR key={phase.phase} className={phase.state === 'ready' ? 'relative state-ready' : 'relative'}>
                <TD className="font-mono text-lg text-ink-faint">
                  <a
                    href={phaseHref(slug, phase.phase)}
                    className="rounded-sm after:absolute after:inset-0 after:content-['']"
                  >
                    {pad2(phase.phase)}
                  </a>
                </TD>
                <TD>
                  <TitleCell phase={phase} />
                </TD>
                <TD>
                  <StateChip state={phase.state} board />
                </TD>
                {/* Both directions, always — this cell used to appear only
                    while a phase was held, so the plan's shape was invisible on
                    every row that was moving. */}
                <TD>
                  <DepsCell slug={slug} phase={phase} />
                </TD>
                <TD>
                  <LockCell lock={phase.lock} />
                </TD>
                <TD>
                  <SizeCell phase={phase} eta={etaFor(detail, phase.phase)} />
                </TD>
                {/* Chips, not the raw graph cell. This was the one table of
                    three printing Repos as a string. */}
                <TD>
                  <ScopeCell phase={phase} />
                </TD>
                <TD>
                  <FlagsCell slug={slug} phase={phase} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableWrap>
    </Card>
  );
}

export function RouteTab({ detail }: { detail: PlanDetail }) {
  const phone = usePhone();
  const slug = detail.summary.slug;
  const closed = isClosed(detail.summary);
  const ready = detail.summary.ready;
  const doneNumbers = detail.phases.filter((p) => p.state === 'done').map((p) => p.phase);
  const lastDone = doneNumbers.length ? Math.max(...doneNumbers) : null;

  return (
    <div className="flex flex-col gap-3">
      <RouteCards detail={detail} />

      <RouteMap
        route={detail.route}
        batches={detail.batches}
        budget={detail.summary.budget}
        onSelect={(phase) => navigate(phaseHref(slug, phase))}
      />

      {/* `--session-plan` answers a closed plan with its CLOSED banner and "No
          sessions to plan", so `groups` is empty and the card below would simply
          vanish. Say why instead: an absent card on a plan that still shows
          unfinished phases reads as the console failing to compute one. */}
      {closed ? (
        <Card>
          <CardHeader>
            <CardTitle>No sessions to plan</CardTitle>
            <span className="text-xs text-ink-faint">this plan is closed</span>
          </CardHeader>
          <CardBody className="text-sm text-ink-muted">
            {detail.summary.closedReason ? <p className="mb-1">{detail.summary.closedReason}</p> : null}
            <p>
              The engine stops batching a closed plan, so there is nothing to suggest. The route above is kept
              in full — it is the record of where the work stopped. Reopen the plan to put its remaining
              phases back on the board.
            </p>
          </CardBody>
        </Card>
      ) : detail.batches?.groups?.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Suggested sessions</CardTitle>
            <span className="text-xs text-ink-faint">
              from <code className="font-mono">phase-graph.sh --session-plan</code> · budget{' '}
              {weight(detail.summary.budget)}
            </span>
          </CardHeader>
          <CardBody className="flex flex-wrap gap-1.5">
            {detail.batches.groups.map((group) => (
              <Chip key={group.index} title={group.note ?? ''}>
                <b>S{group.index}</b>&nbsp;{group.phases.map((p) => `P${p}`).join(' + ')}
                &nbsp;<span className="text-ink-faint">{group.weight}</span>
                {group.gated ? ' · gated' : ''}
              </Chip>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {/* The 8-column nowrap table cannot be true on a phone; the phases-tab
          card list is the same facts, one thumb wide. The DAG above stays —
          its touch stack is the good part. */}
      {phone ? <PhonePhaseList detail={detail} /> : <DeparturesBoard detail={detail} />}

      {/* `--boot-prompt` has no closure guard of its own — it will happily write
          a full prompt for an abandoned plan's phase — so the gate has to be
          here. A card headed "Boot prompt — phase 4" with a Copy button beside
          it is the single most direct invitation this console makes; offering
          one for a plan the operator has closed is the ready board's defect
          wearing a different card. */}
      {!closed && ready.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {ready.map((phase) => (
            <PromptCard
              key={phase}
              title={`Boot prompt — phase ${phase}`}
              queryKey={keys.prompt(slug, phase)}
              load={() => api.prompt(slug, phase)}
            />
          ))}
        </div>
      )}

      {lastDone != null && (
        <PromptCard
          title={`End-of-phase banner — after phase ${lastDone}`}
          note="board · batching advice · every ready prompt"
          collapsed
          queryKey={keys.nextPrompt(slug, lastDone)}
          load={() => api.nextPrompt(slug, lastDone)}
        />
      )}
    </div>
  );
}
