/**
 * Automation — what the autopilot may do by itself, and how much of it.
 *
 * Three cards, in the order the decisions nest. **Defaults** are the opening
 * values every launch surface starts from (`RunSetup` in `defaults` mode — the
 * same component, words and order as the launch dialog, so "the default" and
 * "this launch" are visibly one form rather than two that happen to agree).
 * **The ladder** is what happens when a phase stops: how far the console climbs
 * on its own, what it may spend doing so, and when a session counts as stalled.
 * **The session hook** is what lets it see the sessions it shares the
 * repository with — the input the other two act on.
 *
 * Every knob here governs the SERVER process and is rendered from
 * `/api/state`, never from a local copy of the intention. That is the line
 * between this section and Appearance, whose preferences live in this browser.
 */

import { SettingsSectionFrame, sectionFor } from './nav';
import { AutomationCard } from './automation-card';
import { LadderCard } from './ladder';
import { SessionHookCard } from './hooks';

export function AutomationSection() {
  const section = sectionFor('automation')!;
  return (
    <SettingsSectionFrame section={section}>
      <AutomationCard />
      <LadderCard />
      <SessionHookCard />
    </SettingsSectionFrame>
  );
}
