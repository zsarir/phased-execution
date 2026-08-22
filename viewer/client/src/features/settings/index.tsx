/**
 * Settings — the destination.
 *
 * `#/settings` is the section index; `#/settings/:section` is one section.
 * 2.x rendered all fifteen cards in one scroll with no address for any of
 * them, so "turn the repository guard off" could only be given as *scroll until
 * you find Automation*, and nothing — an errand, a guide page, a push payload —
 * could link to a setting.
 *
 * The three rules that shape this file:
 *
 * 1. **An unknown section is the index, not a blank frame.** `SECTION_IDS` is
 *    the accepted set; anything else falls through to the list, which is the
 *    `ROUTE_HEADS` discipline one level down. A typo in a bookmark lands
 *    somewhere useful.
 * 2. **The nav is a `<nav>` of real links** (`nav.tsx`), so every section can be
 *    opened in a new tab and copied as a URL. That is the whole point of giving
 *    each one an address.
 * 3. **Sections are lazy where they are heavy.** Only `mcp` and `permissions`
 *    carry enough of their own (a catalog with a search and an add dialog; a
 *    rule editor) to be worth their own chunk; the rest are cards this chunk
 *    already needs. Settings is a DESTINATION, so this chunk is precached —
 *    everything imported statically here is downloaded on install by everyone.
 */

import { Suspense, lazy } from 'react';
import { cn } from '@/lib/cn';
import type { ViewProps } from '@/app/router';
import { Page } from '@/components/page';
import { Card, CardBody, CardHeader, CardTitle, Spinner } from '@/components/ui';
import { SETTINGS_SECTIONS, SettingsNav, SettingsSectionFrame, sectionFor } from './nav';
import { GeneralSection } from './general';
import { AppearanceSection } from './appearance';
import { AutomationSection } from './automation';
import { ProcessSection } from './process';
import { AccountsCard } from './accounts';
import { PreferencesCard } from './alerts';
import { DevicesCard } from './devices';

// The two heavy halves. The permissions editor is a form over a rule grammar;
// the MCP section carries a catalog, a search and an add dialog. Neither is on
// the path of a person who opened Settings to flip a theme.
const McpSection = lazy(() => import('./mcp').then((m) => ({ default: m.McpSection })));
const PermissionsSection = lazy(() =>
  import('./permissions').then((m) => ({ default: m.PermissionsSection })),
);

export default function SettingsView({ route }: ViewProps) {
  const requested = route.segments[1];
  const section = sectionFor(requested);

  return (
    <Page title="Settings" subtitle="Phase Console">
      {/* The rail exists only BESIDE a section. On the index the list IS the
          page, so a rail would be the same eight links twice — which is not
          only redundant, it is ambiguous: two navigations with one accessible
          name is what a screen reader (and `getByRole`) reads as a broken
          landmark, and it is how the section test caught this. */}
      <div className={cn('grid min-w-0 gap-4', section && 'lg:grid-cols-[220px_minmax(0,1fr)]')}>
        {section && <SettingsNav current={section.id} className="hidden lg:block" />}

        <div className="min-w-0">
          {section ? (
            <>
              {/* Where you are, and the way back — a phone has no rail. */}
              <a
                href="#/settings"
                className="mb-3 inline-flex min-h-(--tap-min) items-center text-sm text-ink-muted hover:text-ink lg:hidden"
              >
                ← All settings
              </a>
              <Suspense
                fallback={
                  <div className="grid place-items-center py-16">
                    <Spinner />
                  </div>
                }
              >
                <SectionBody id={section.id} route={route} />
              </Suspense>
            </>
          ) : (
            <SettingsIndex />
          )}
        </div>
      </div>
    </Page>
  );
}

/** The index: every section, with the question it answers. */
function SettingsIndex() {
  return (
    <div className="min-w-0">
      <p className="mb-3 text-sm text-ink-muted">
        {SETTINGS_SECTIONS.length} sections. Each has its own address — link to one from a handoff, a guide
        page or a note.
      </p>
      <SettingsNav variant="index" />
    </div>
  );
}

function SectionBody({ id, route }: { id: string; route: ViewProps['route'] }) {
  switch (id) {
    case 'general':
      return <GeneralSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'automation':
      return <AutomationSection />;
    case 'accounts':
      return <AccountsSection />;
    case 'alerts':
      return <AlertsSection />;
    case 'mcp':
      return <McpSection route={route} />;
    case 'permissions':
      return <PermissionsSection />;
    case 'process':
      return <ProcessSection />;
    default:
      return <SettingsIndex />;
  }
}

/* ---------------- the one-card sections ---------------- */

function AccountsSection() {
  return (
    <SettingsSectionFrame section={sectionFor('accounts')!}>
      <AccountsCard />
    </SettingsSectionFrame>
  );
}

/**
 * Alerts: what is announced, then which devices hear it — in that order,
 * because the first governs the console and the second only decides where an
 * already-allowed push goes. Reversing them puts the narrower switch above the
 * one that overrides it, which is the confusion the 2.x single card created:
 * its "what to send" list looked global and was per-device, so it silently did
 * nothing on a console with no device.
 */
function AlertsSection() {
  return (
    <SettingsSectionFrame section={sectionFor('alerts')!}>
      <Card>
        <CardHeader>
          <CardTitle>The announcements themselves</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-ink-muted">
            Everything the console has announced — including what arrived while nothing was open to hear it —
            is the bell in the header.{' '}
            <a href="#/now?bell=1&amp;panel=announcements" className="text-action underline">
              Open the announcements
            </a>
            .
          </p>
        </CardBody>
      </Card>
      <PreferencesCard />
      <DevicesCard />
    </SettingsSectionFrame>
  );
}
