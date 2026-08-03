/**
 * The operating guide, as deep-linkable tabbed sections.
 *
 * The legacy guide was one long scroll with an in-page anchor (`#verified`) that
 * a hash router ate — the link went nowhere, because `#verified` *is* the route.
 * Sections are routes now (`#/guide/mobile`), which fixes that by construction:
 * there are no in-page anchors left to break, every section can be linked to,
 * and a reload lands where you were.
 *
 * The prose lives in `client/src/content/guide/*.md` and renders through the
 * Phase 3 sanitizer, so the guide is text a person can edit rather than markup a
 * component owns.
 */

import { useConsoleState } from '@/lib/queries';
import { Markdown } from '@/components/markdown';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { navigate } from '@/router';
import type { ViewProps } from '@/router';
import { Page } from '../_page';
import { SECTIONS, resolveSection } from './sections';

export default function GuideView({ route }: ViewProps) {
  const { data: state } = useConsoleState();
  const section = resolveSection(route.segments[1]);

  return (
    <Page
      title="Guide"
      subtitle="The console reads a phased plan and can execute it: one fresh session per phase, checked independently, pausing when it needs you."
    >
      <ConsolePosture state={state} />

      <Tabs value={section.id} onValueChange={(id) => navigate(`guide/${id}`)}>
        <TabsList aria-label="Guide sections">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>{s.label}</TabsTrigger>
          ))}
        </TabsList>

        {SECTIONS.map((s) => (
          <TabsContent key={s.id} value={s.id} className="pt-4">
            {s.id === section.id && (
              <article className="mx-auto max-w-[72ch]">
                <p className="mb-3 text-sm text-ink-muted">{s.lede}</p>
                <Markdown text={s.body} />
              </article>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </Page>
  );
}

/**
 * What this console can actually do, said before the guide describes what a
 * console can do in general. Reading "start a run" on a console that cannot is
 * the fastest way to conclude the software is broken.
 */
function ConsolePosture({ state }: { state: { autopilot?: boolean; allowRun?: boolean } | undefined }) {
  if (!state) return null;
  const on = state.autopilot === true && state.allowRun === true;
  const text = state.autopilot === false
    ? 'This console predates the autopilot. Restart it to pick up the run endpoints.'
    : state.allowRun
      ? 'Runs are enabled on this console.'
      : 'This console can show runs but not start them — it was started without --allow-run.';

  return (
    <p className="mb-4 flex items-center gap-2 text-sm text-ink-muted">
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${on ? 'bg-done' : 'bg-ink-faint/50'}`}
      />
      {text}
    </p>
  );
}
