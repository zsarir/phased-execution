/**
 * Notification settings: the plumbing that delivers what the console announces.
 *
 * The **inbox** half of this page — the record of everything announced, whether
 * or not anything was listening — became the bell drawer in 3.0
 * (`app/notifications/drawer.tsx`), because reading what the console said should
 * not cost leaving what you are looking at. `#/notifications` redirects there;
 * this is what `#/notifications/settings` still renders, and Phase 11 folds it
 * into `#/settings/alerts` and deletes the head.
 *
 * Two cards, in the order the decisions are actually made. **What to announce**
 * comes first because it governs the console — a category switched off there
 * produces no record, no event, no command and no push. **Devices** comes second
 * because it only decides which subscribed device a push that was already
 * allowed goes to. Reversing them puts the narrower switch above the one that
 * overrides it, which is the confusion the old single card created: its "what to
 * send" list looked global and was per-device, so it silently did nothing on a
 * console with no device.
 */

import { Banner } from '@/components/ui';
import { Page } from '@/components/page';
import { DevicesCard } from './devices';
import { PreferencesCard } from './preferences';

export default function NotificationsView() {
  return (
    <Page
      title="Alerts"
      subtitle="What the console announces, and which devices hear it. The announcements themselves are in the bell drawer."
    >
      <Banner severity="info">
        <div className="min-w-0">
          <strong>Looking for what the console has said?</strong> It is the bell in the header —{' '}
          <a href="#/now?bell=1&amp;panel=announcements" className="text-action underline">
            open the announcements
          </a>
          .
        </div>
      </Banner>

      <div className="mt-4 flex flex-col gap-4">
        <PreferencesCard />
        <DevicesCard />
      </div>
    </Page>
  );
}
