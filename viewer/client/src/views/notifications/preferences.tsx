/**
 * What the console is allowed to say — the switch that used to lie.
 *
 * This card exists because the one next to it was doing a job it could not do.
 * Categories were stored **per subscribed push device**, which had two
 * consequences nobody could see from the UI: switching a category off filtered
 * the push leg and nothing else (the inbox record, the SSE event and
 * `PHASE_CONSOLE_NOTIFY` all still fired), and a console with no device
 * subscribed had nowhere to store the preference at all — so the toggles were
 * not merely partial, they were absent. An inbox reaching 182 unread
 * notifications in a category that is off by default is what that looks like
 * from the operator's chair.
 *
 * So there are two tiers now, and the split is worth stating because the cards
 * sit next to each other:
 *
 *   **here** — whether the console announces a category *at all*, on every leg.
 *   **Devices** — which of the subscribed phones and laptops a push goes to.
 *
 * The first is a property of the console and lives in its config file; the
 * second is a property of a device and lives with that device. Nothing here
 * needs a subscription, a service worker or a signing key, which is the point:
 * this card is fully usable on a console that has never sent a push.
 *
 * State is read from `/api/state` rather than kept locally. A preference that
 * governs a server process has to be rendered from what that process actually
 * holds — a local copy would show the operator their intention instead of the
 * setting.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, useConsoleState, usePush } from '@/lib/queries';
import { api } from '@/lib/api';
import { Banner, Card, CardBody, CardHeader, CardTitle, Chip, Skeleton, toast } from '@/components/ui';

/**
 * The categories that mean "nothing proceeds until you look". Turning one of
 * these off is a legitimate choice — an operator who watches the console all day
 * does not need to be told twice — but it is the choice most likely to be made
 * by accident while trying to stop a firehose, so it says so once, in place,
 * rather than being discovered when a run sits halted overnight.
 */
const LOAD_BEARING = new Set(['approval', 'needs-you', 'halted']);

export function PreferencesCard() {
  const client = useQueryClient();
  const { data: state, isPending } = useConsoleState();
  // The catalogue is already served beside the push register; it is the same
  // table the server gates on, so the two cannot drift.
  const { data: push } = usePush();

  const save = useMutation({
    // A delta, not the whole map: the server merges it over what is stored, so
    // two tabs toggling different categories do not overwrite each other.
    mutationFn: (next: Record<string, boolean>) => api.savePrefs({ notify: next }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.state() });
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (isPending && !state) return <Skeleton className="h-64" />;

  const categories = push?.categories ?? [];
  const notify = state?.prefs?.notify ?? {};
  // Before the catalogue arrives there is nothing to render toggles from, and a
  // card that renders an empty list reads as "no categories", not "loading".
  if (!categories.length) return <Skeleton className="h-64" />;

  const silenced = categories.filter((c) => notify[c.id] === false);
  const mutedImportant = silenced.filter((c) => LOAD_BEARING.has(c.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>What to announce</CardTitle>
        <span className="text-2xs text-ink-faint">
          {silenced.length ? `${silenced.length} of ${categories.length} silenced` : 'all on'}
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-2xs text-ink-muted">
          Applies to the whole console: a category switched off here is not written to the inbox, not sent to
          an open tab, not passed to <code>PHASE_CONSOLE_NOTIFY</code> and not pushed to any device. Nothing
          below needs a device subscribed.
        </p>

        {mutedImportant.length > 0 && (
          <Banner severity="warn">
            <strong>
              {mutedImportant.map((c) => c.label).join(', ')} {mutedImportant.length === 1 ? 'is' : 'are'}{' '}
              off.
            </strong>{' '}
            {mutedImportant.length === 1 ? 'That category' : 'Those categories'} covers work that stops dead
            until you act — a halted run or an unanswered permission card will now wait without telling you.
          </Banner>
        )}

        <div className="flex flex-col gap-2">
          {categories.map((category) => {
            // A category the config has never seen takes its catalogue default,
            // exactly as the server resolves it — so the checkbox shows what
            // would actually happen rather than an unchecked box.
            const on = notify[category.id] ?? category.byDefault;
            return (
              <label key={category.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 accent-[var(--action)]"
                  checked={on}
                  disabled={save.isPending}
                  aria-label={category.label}
                  onChange={(event) => save.mutate({ [category.id]: event.target.checked })}
                />
                <span className="min-w-0">
                  <span className="text-sm text-ink">{category.label}</span>
                  {category.urgent && (
                    <Chip tone="warn" className="ml-1.5">
                      urgent
                    </Chip>
                  )}
                  {!on && <Chip className="ml-1.5">off</Chip>}
                  <span className="mt-0.5 block text-2xs text-ink-muted">{category.detail}</span>
                </span>
              </label>
            );
          })}
        </div>

        <p className="text-2xs text-ink-muted">
          Stored with the console, in <code>~/.config/phase-console/config.json</code> — so it survives a
          restart and applies however you are reading the console.
        </p>
      </CardBody>
    </Card>
  );
}
