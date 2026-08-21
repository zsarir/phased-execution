/**
 * The axe smoke for a rendered primitive.
 *
 * jsdom lays nothing out, so the colour-contrast rule cannot run here (it
 * reports "incomplete", never a violation) — contrast is asserted by
 * `styles/contrast.test.ts` from the stylesheet instead. Everything structural
 * axe can see in a DOM without layout — names, roles, labels, ARIA validity,
 * nesting — it checks, and one violation fails the test with axe's own words.
 */

import axe, { type Result } from 'axe-core';

/** Rules that need layout or a live browser and only ever report "incomplete" in jsdom. */
const DISABLED = ['color-contrast', 'region', 'landmark-one-main', 'page-has-heading-one'];

export async function axeViolations(node: Element | Document = document): Promise<Result[]> {
  const results = await axe.run(node, {
    rules: Object.fromEntries(DISABLED.map((id) => [id, { enabled: false }])),
    // Smoke, not audit: the WCAG 2.x A/AA rule sets, which is what the app
    // promises. Best-practice rules are advisory and noisy in a fragment.
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  });
  return results.violations;
}

/** One line per violation, with the offending node, for the assertion message. */
export function describeViolations(violations: Result[]): string {
  return violations
    .map((v) => `${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}: ${n.failureSummary ?? ''}`).join('\n')}`)
    .join('\n');
}

/** Assert a rendered fragment has no axe violations. */
export async function expectNoAxeViolations(node: Element | Document = document): Promise<void> {
  const violations = await axeViolations(node);
  if (violations.length) throw new Error(`axe found ${violations.length} violation(s):\n${describeViolations(violations)}`);
}
