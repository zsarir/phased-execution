/**
 * A session's vitals for the top bar: plan · phase · time passed · ETA.
 *
 * A live session page answered "what is this?" with a label and nothing else —
 * which plan it serves, which phase, how long it has been at it and how long
 * that phase usually takes were all facts the console already held and did not
 * say. The linkage comes from the session's own meta (recovery and QA sessions
 * are minted against a `(slug, phase)`); the estimate is the plan detail's
 * per-phase ETA, basis-labelled, and past it the line says "over estimate"
 * rather than counting to a fictitious zero. A session with no plan linkage
 * shows the clock alone — never an invented attribution.
 *
 * ⚠️ Imported by BOTH session pages, so it lives in `views/terminal/` and is
 * re-exported through `pane.tsx` — the single-facade rule. A second module
 * imported directly by both routes renames the shared `pane-*` chunk and slips
 * past the precache exclusions (see pane.tsx's re-export note; check-dist
 * holds both ends).
 */

import { Timer } from 'lucide-react';

import { Chip } from '@/components/ui';
import { usePlan } from '@/lib/queries';
import { useNow } from '@/lib/clock';
import { elapsed } from '@/lib/format';
import { planHref } from '@shared/routes.js';
import type { TerminalSession } from '@/lib/api';

/** The plan/phase a session was minted against, when it names one. */
export function sessionLinkage(session: TerminalSession): { slug?: string; phase?: number } {
  const meta = session.meta;
  if (meta?.recovery?.slug) {
    return {
      slug: meta.recovery.slug,
      ...(meta.recovery.phase != null ? { phase: meta.recovery.phase } : {}),
    };
  }
  if (meta?.qa?.slug) return { slug: meta.qa.slug, phase: meta.qa.phase };
  return {};
}

export function SessionVitals({ session }: { session: TerminalSession }) {
  const { slug, phase } = sessionLinkage(session);
  const live = !session.exitedAt;
  const now = useNow(live);
  const { data: detail } = usePlan(slug);
  const eta = phase != null
    ? detail?.eta?.perPhase.find((estimate) => estimate.phase === phase)
    : undefined;
  const ms = Math.max(0, (live ? now : session.exitedAt ?? now) - session.createdAt);
  const over = Boolean(eta && ms > eta.estMs);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-2xs">
      {slug && (
        <a href={planHref(slug, 'run')} className="min-w-0">
          <Chip mono className="max-w-56 truncate" title="The plan this session serves — opens its autopilot page.">
            {slug}
            {phase != null ? ` · P${phase}` : ''}
          </Chip>
        </a>
      )}
      {session.meta?.intent === 'plan' && !slug && (
        <Chip title="Authoring a plan — it gets a slug when you approve one.">plan session</Chip>
      )}
      <span
        className="inline-flex items-center gap-1 font-mono text-sm font-semibold tabular-nums text-ink"
        title={live ? 'Time this session has been running.' : 'How long the session ran.'}
      >
        <Timer size={13} aria-hidden className="shrink-0 text-ink-faint" />
        {elapsed(ms)}
      </span>
      {eta && (
        <span
          className="font-mono tabular-nums text-ink-faint"
          title={`This phase's own estimate — ${eta.label}. Past it the honest word is "over", not a countdown.`}
        >
          {over ? 'over the ~' : '/ ~'}
          {elapsed(eta.estMs)}
          {over ? ' estimate' : ' est'}
        </span>
      )}
    </div>
  );
}
