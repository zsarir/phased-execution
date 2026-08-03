import { PLAN_TABS } from '@shared/route-meta.js';
import { Chip } from '@/components/ui';
import { Page } from './_page';
import type { ViewProps } from '@/router';

/**
 * The plan surface — tabs, the route map, phase and handoff detail, the markdown
 * pipeline — is Phase 3. What exists here is the route: `#/plan/:slug/:tab` and
 * `#/plan/:slug/phase/:n` parse, deep-link and survive a reload, which is what
 * the shell needs to be verifiable before the content lands.
 */
export default function PlanView({ route }: ViewProps) {
  const [, slug, tab] = route.segments;
  return (
    <Page title={slug ?? 'Plan'} subtitle={tab ? `tab — ${tab}` : undefined}>
      <p className="text-sm text-ink-muted">
        The plan surface is built in Phase 3: tabs, the dependency map, phase and handoff
        detail, and the markdown pipeline.
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(PLAN_TABS as readonly string[]).map((id) => (
          <Chip key={id} mono tone={id === tab ? 'warn' : 'neutral'}>{id}</Chip>
        ))}
      </div>
    </Page>
  );
}
