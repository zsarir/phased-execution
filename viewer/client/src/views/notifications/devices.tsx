/**
 * The delivery plumbing: how a notification gets out of this process.
 *
 * The distinction this card is built around is the whole reason someone opens
 * it:
 *
 *   **in this tab** — the Notification API. Free, instant, and gone with the tab.
 *   **on this device** — a push subscription, which arrives with nothing open.
 *
 * Being told about a halted run at 3am and being told about it when you next
 * look at the console are not the same feature, and only one of them needs a
 * service worker and a signing key.
 *
 * ⚠️ Phase 7 owns the service worker's *contents* (vite-plugin-pwa). It must
 * keep `/sw.js` at the same URL and scope: the subscriptions this card creates
 * are bound to them, and moving the file silently unsubscribes every device
 * with nothing to announce that it happened. See `lib/push.ts`.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, useInbox, usePush } from '@/lib/queries';
import { api, type PushDevice } from '@/lib/api';
import { askToNotify, notifyState, type NotifyState } from '@/lib/notify';
import { blocker, currentEndpoint, describeBrowser, disable, enable, iosNeedsInstall } from '@/lib/push';
import {
  Banner, Button, Card, CardBody, CardHeader, CardTitle, Chip, Skeleton, toast,
} from '@/components/ui';
import { plural } from '@/lib/format';

export function DevicesCard() {
  const client = useQueryClient();
  const { data: push, isPending } = usePush();
  // The last few announcements, so the card can answer "did anything actually
  // arrive" rather than only "is a device registered".
  const { data: reach } = useInbox({ limit: 25 });

  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [inTab, setInTab] = useState<NotifyState>(() => notifyState());

  useEffect(() => { void currentEndpoint().then(setEndpoint); }, []);

  const refresh = async () => {
    setEndpoint(await currentEndpoint());
    await client.invalidateQueries({ queryKey: keys.push() });
  };

  // Which row is this browser? The endpoint is the only thing that says so, and
  // the server never returns it — so the client matches on the one it holds.
  const mine = push?.devices.find((d) => d.service && endpoint?.startsWith(d.service)) ?? null;
  const subscribed = Boolean(endpoint && mine);
  const why = blocker();

  const subscribe = useMutation({
    mutationFn: () => enable(),
    onSuccess: async (result) => {
      toast(result.ok ? 'This device will be notified.' : result.detail ?? 'Not subscribed',
        result.ok ? 'ok' : 'error');
      await refresh();
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const unsubscribe = useMutation({
    mutationFn: () => disable(),
    onSuccess: refresh,
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.pushTest(id),
    onSuccess: (result) => {
      // "Accepted" is the truth and is not the same as "you saw it": the push
      // service, the browser and the operating system are three separate yeses,
      // and only the first one answers back. Saying just "sent" makes a muted
      // OS look like a broken console.
      toast(
        result.ok
          ? 'Handed to the push service. If nothing appeared, it got no further than your system '
            + 'notification settings for this browser.'
          : `Not sent — ${result.detail}`,
        result.ok ? 'ok' : 'error',
      );
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const categories = useMutation({
    mutationFn: ({ id, next }: { id: string; next: Record<string, boolean> }) =>
      api.pushCategories(id, next),
    onSuccess: refresh,
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (isPending && !push) return <Skeleton className="h-64" />;

  const deviceCount = push?.devices.length ?? 0;
  const busy = subscribe.isPending || unsubscribe.isPending || test.isPending || categories.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <span className="text-2xs text-ink-faint">{plural(deviceCount, 'device')} subscribed</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {!deviceCount && !why && (
          <Banner severity="info">
            <strong>Nothing has ever been sent from this console.</strong> No browser has
            subscribed, so every announcement so far reached the inbox and stopped there. Turning
            it on below takes one permission prompt and covers this device with the console closed.
          </Banner>
        )}

        <Lane
          title="In this tab"
          detail="Raised by the page. Costs nothing and needs no setup, but only exists while a tab is open."
        >
          {inTab === 'granted' ? <Chip tone="ok">on</Chip>
            : inTab === 'denied' ? <span className="text-2xs text-ink-faint">blocked in browser settings</span>
              : inTab === 'unsupported' ? <span className="text-2xs text-ink-faint">unsupported here</span>
                : (
                  <Button size="sm" onClick={async () => setInTab(await askToNotify())}>Allow</Button>
                )}
        </Lane>

        <Lane
          title="On this device"
          detail={`Delivered through a push service, so it arrives with the console closed — the case an
                   unattended run exists for. ${describeBrowser()}.`}
        >
          {subscribed && mine ? (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => test.mutate(mine.id)}>
                {test.isPending ? 'Sending…' : 'Send a test'}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => unsubscribe.mutate()}>
                Turn off
              </Button>
            </div>
          ) : why ? null : (
            <Button size="sm" variant="action" disabled={busy} onClick={() => subscribe.mutate()}>
              {subscribe.isPending ? 'Subscribing…' : 'Turn on'}
            </Button>
          )}
        </Lane>

        {why && <Banner severity={iosNeedsInstall() ? 'info' : 'warn'}>{why}</Banner>}

        {subscribed && mine && push?.categories.length ? (
          <div>
            <h3 className="mb-2 font-display text-2xs tracking-[0.14em] text-ink-faint uppercase">
              What to push to this device
            </h3>
            {/*
              This list narrows; it does not enable. It used to be the only
              category control in the console, which made it look global — and
              on a console with no device subscribed it did not exist at all.
              Whether a category is announced is decided above, in
              "What to announce".
            */}
            <p className="mb-2 text-2xs text-ink-muted">
              Only narrows what <strong>What to announce</strong> already allows — a category
              switched off there never reaches any device, whatever is ticked here.
            </p>
            <div className="flex flex-col gap-2">
              {push.categories.map((category) => (
                <label key={category.id} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--action)]"
                    checked={mine.categories?.[category.id] === true}
                    disabled={busy}
                    onChange={(event) => categories.mutate({
                      id: mine.id,
                      next: { ...mine.categories, [category.id]: event.target.checked },
                    })}
                  />
                  <span className="min-w-0">
                    <span className="text-sm text-ink">{category.label}</span>
                    {category.urgent && <Chip tone="warn" className="ml-1.5">urgent</Chip>}
                    <span className="mt-0.5 block text-2xs text-ink-muted">{category.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {deviceCount > 1 && (
          <div>
            <h3 className="mb-2 font-display text-2xs tracking-[0.14em] text-ink-faint uppercase">
              Other devices
            </h3>
            <div className="flex flex-col gap-1">
              {push!.devices.filter((d) => d.id !== mine?.id).map((device) => (
                <OtherDevice
                  key={device.id}
                  device={device}
                  busy={busy}
                  onTest={() => test.mutate(device.id)}
                />
              ))}
            </div>
          </div>
        )}

        {reach && <DeliveryReadout reach={reach} />}

        {subscribed && (
          <p className="text-2xs text-ink-muted">
            A test that says it was handed over and never appears has almost always been stopped by
            the operating system rather than by anything here — macOS{' '}
            <em>System Settings → Notifications → your browser</em>, or Windows{' '}
            <em>Settings → System → Notifications</em>. A Focus or Do Not Disturb mode does the same
            thing silently.
          </p>
        )}

        <p className="text-2xs text-ink-muted">
          For a machine with no browser in the picture at all,{' '}
          <code>PHASE_CONSOLE_NOTIFY=&lt;command&gt;</code> is run with the title and body of every
          one of these.{' '}
          {reach && !reach.outOfBand?.configured ? (
            <>
              It is <strong>not set</strong> for this process — and under launchd it has to be in
              the plist, not in your shell:{' '}
              <code>deploy/agent.sh install --notify &apos;&lt;command&gt;&apos;</code>.
            </>
          ) : reach ? 'It is set.' : null}
        </p>
      </CardBody>
    </Card>
  );
}

function Lane({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-rule bg-surface-raised px-3 py-2">
      <div className="min-w-0 flex-1">
        <strong className="text-sm text-ink">{title}</strong>
        <p className="mt-0.5 text-2xs text-ink-muted">{detail}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function OtherDevice({
  device,
  busy,
  onTest,
}: {
  device: PushDevice;
  busy: boolean;
  onTest: () => void;
}) {
  const chosen = Object.values(device.categories ?? {}).filter(Boolean).length;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-rule px-3 py-2">
      <div className="min-w-0 flex-1">
        <strong className="text-sm text-ink">{device.label}</strong>
        <span className="ml-1.5 text-2xs text-ink-faint">
          {plural(chosen, 'category', 'categories')}
          {device.lastOkAt
            ? ` · last reached ${new Date(device.lastOkAt).toLocaleString()}`
            : ' · never reached'}
        </span>
      </div>
      <Button size="sm" disabled={busy} onClick={onTest}>Test</Button>
    </div>
  );
}

/**
 * What actually became of the last few announcements.
 *
 * The register answers "is a device subscribed", which is not the question. A
 * subscription can be live, chosen for every category, and still deliver
 * nothing — a push service refusing, an endpoint that died months ago, an
 * operating system dropping it silently. `announce()` is deliberately not
 * awaited so none of that can stall a run, which is exactly why none of it was
 * ever visible. Here it is.
 */
function DeliveryReadout({ reach }: { reach: { items: { delivery?: { label: string; outcome: string }[] }[] } }) {
  const items = reach.items ?? [];
  if (!items.length) return null;

  const attempted = items.filter((r) => (r.delivery ?? []).length);
  const undelivered = items.length - attempted.length;
  const failures = attempted.flatMap((r) => (r.delivery ?? []).filter((d) => d.outcome !== 'sent'));

  return (
    <div className="rounded border border-rule bg-surface-raised px-3 py-2">
      <strong className="text-sm text-ink">What has been reaching you</strong>
      <p className="mt-0.5 text-2xs text-ink-muted">
        Of the last {plural(items.length, 'announcement')}, {attempted.length} went to a device
        {undelivered
          ? ` and ${undelivered} reached no device at all — those exist only in the inbox`
          : ''}.
      </p>
      {failures.length > 0 && (
        <p className="mt-1 text-2xs text-blocked">
          {plural(failures.length, 'handover')} did not succeed:{' '}
          {[...new Set(failures.map((f) => `${f.label} · ${f.outcome}`))].join(', ')}.
        </p>
      )}
    </div>
  );
}
