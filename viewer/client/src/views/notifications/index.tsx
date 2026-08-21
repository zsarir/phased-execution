/**
 * Notifications: the history, and the plumbing that delivers them.
 *
 * Two tabs, because they answer two different questions and only one of them is
 * about setup. **Inbox** is what the console has told you — everything it
 * announced, whether or not anything was listening at the time, which is the
 * failure this page exists for. **Settings** is everything upstream of that,
 * and it is deliberately downstream of the inbox rather than the other way
 * round: the inbox works with nothing configured at all.
 *
 * The settings tab holds two cards in the order the decisions are actually
 * made. **What to announce** comes first because it governs the console — a
 * category switched off there produces no record, no event, no command and no
 * push. **Devices** comes second because it only decides which subscribed
 * device a push that was already allowed goes to. Reversing them puts the
 * narrower switch above the one that overrides it, which is the confusion the
 * old single card created: its "what to send" list looked global and was
 * per-device, so it silently did nothing on a console with no device.
 *
 * The tab is a sub-route (`#/notifications/settings`) so it deep-links and
 * survives a reload — and so the "Set a device up" link inside the inbox has
 * somewhere real to point.
 */

import { useState } from 'react';
import { Chip, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { navigate } from '@/router';
import type { ViewProps } from '@/router';
import { Page } from '../_page';
import { Inbox } from './inbox';
import { DevicesCard } from './devices';
import { PreferencesCard } from './preferences';

const TABS = [
  { id: 'inbox', label: 'Inbox' },
  // The id stays `settings` — it is what `routeFor` and every existing deep
  // link already name. Only the label follows what the tab now holds.
  { id: 'settings', label: 'Settings' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** `settings` keeps its legacy id — the server's `routeFor` builds that URL. */
function resolveTab(segment: string | undefined): TabId {
  return TABS.some((t) => t.id === segment) ? (segment as TabId) : 'inbox';
}

export default function NotificationsView({ route }: ViewProps) {
  const tab = resolveTab(route.segments[1]);
  const [unread, setUnread] = useState(0);

  return (
    <Page
      title="Notifications"
      subtitle="Everything the console announced — kept whether or not a tab was open or a device was subscribed to hear it."
      actions={unread > 0 ? <Chip tone="warn">{unread} unread</Chip> : undefined}
    >
      <Tabs value={tab} onValueChange={(id) => navigate(`notifications/${id}`)}>
        <TabsList aria-label="Notification sections">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
              {t.id === 'inbox' && unread > 0 && (
                <span className="ml-1.5 font-mono text-2xs text-action">{unread}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="inbox">{tab === 'inbox' && <Inbox onUnread={setUnread} />}</TabsContent>
        <TabsContent value="settings" className="pt-4">
          {tab === 'settings' && (
            <div className="flex flex-col gap-4">
              <PreferencesCard />
              <DevicesCard />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
