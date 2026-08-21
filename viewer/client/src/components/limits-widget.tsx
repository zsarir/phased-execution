/**
 * The usage meters — "how much Claude is left" in the console's own chrome.
 *
 * Two questions, answered at two depths. The compact widget (rail footer,
 * phone header) answers "am I about to hit a wall?" for the account most runs
 * spend: the 5-hour window and the worst weekly one, as bars. The dialog
 * behind it answers the rest: every registered account, every bucket the
 * usage endpoint reports (rendered by KEY, so a window that ships tomorrow
 * appears tomorrow), reset countdowns, and how stale each answer is.
 *
 * The numbers come from `/api/accounts` and move on the `accounts` SSE event;
 * this module never fetches anything itself. Mounted in the rail AND the
 * phone header — a widget added to one shell is missing on the other form
 * factor, which is the mistake the two variants exist to prevent.
 */

import { useState } from 'react';
import { Gauge } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { keys, useAccounts, useConsoleState } from '@/lib/queries';
import { api } from '@/lib/api';
import type { AccountView, UsageBucket } from '@/lib/api';
import { countdown, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button, Chip, Dialog, DialogContent, Empty, toast } from '@/components/ui';

/** Human names for the endpoint's bucket keys; unknown keys stay readable. */
export function bucketLabel(bucket: string): string {
  if (bucket === 'five_hour') return '5-hour session';
  if (bucket === 'seven_day') return 'Weekly (all models)';
  const model = /^seven_day_(.+)$/.exec(bucket)?.[1];
  if (model) return `Weekly (${model[0].toUpperCase()}${model.slice(1)})`;
  return bucket.replace(/_/g, ' ');
}

/** Warn at 80, alert at 95 — the same thresholds the server announces at. */
function tone(pct: number): string {
  if (pct >= 95) return 'bg-stuck';
  if (pct >= 80) return 'bg-ready';
  return 'bg-done';
}

function Meter({ pct, className }: { pct: number; className?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-track', className)}
      role="img"
      aria-label={`${Math.round(clamped)}% used`}
    >
      <div className={cn('h-full', tone(clamped))} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** The worst weekly bucket — all-models and each per-model one compete. */
function worstWeekly(account: AccountView | undefined): { key: string; bucket: UsageBucket } | null {
  const buckets = account?.usage?.buckets ?? {};
  let worst: { key: string; bucket: UsageBucket } | null = null;
  for (const [key, bucket] of Object.entries(buckets)) {
    if (!key.startsWith('seven_day')) continue;
    if (!worst || bucket.utilization > worst.bucket.utilization) worst = { key, bucket };
  }
  return worst;
}

/**
 * The account whose five-hour window is closest to its wall. The compact bar
 * is an early-warning instrument: it showed only the machine login, so a
 * second account could walk into its wall with every meter in the chrome
 * green. Worst-of-all is the honest headline; the per-account truth is one
 * click away in the dialog.
 */
function worstFive(
  accounts: AccountView[] | undefined,
): { account: AccountView; bucket: UsageBucket } | null {
  let worst: { account: AccountView; bucket: UsageBucket } | null = null;
  for (const account of accounts ?? []) {
    const bucket = account.usage?.buckets.five_hour;
    if (!bucket) continue;
    if (!worst || bucket.utilization > worst.bucket.utilization) worst = { account, bucket };
  }
  return worst;
}

/** The worst weekly bucket across EVERY account — all-models and per-model compete. */
function worstWeeklyAcross(
  accounts: AccountView[] | undefined,
): { account: AccountView; key: string; bucket: UsageBucket } | null {
  let worst: { account: AccountView; key: string; bucket: UsageBucket } | null = null;
  for (const account of accounts ?? []) {
    const weekly = worstWeekly(account);
    if (weekly && (!worst || weekly.bucket.utilization > worst.bucket.utilization)) {
      worst = { account, ...weekly };
    }
  }
  return worst;
}

function accountName(account: AccountView): string {
  if (account.builtIn) return account.name ?? account.email ?? 'This machine’s login';
  return account.name ?? account.email ?? account.id;
}

export function LimitsWidget({ variant }: { variant: 'rail' | 'phone' | 'sheet' }) {
  const [open, setOpen] = useState(false);
  const { data } = useAccounts();
  const accounts = data?.accounts;
  const several = (accounts?.length ?? 0) > 1;
  const five = worstFive(accounts);
  const weekly = worstWeeklyAcross(accounts);
  // Stale is about the number on screen: the account SUPPLYING a meter could
  // not be read, so the bar may be older than it looks.
  const stale = Boolean(
    five?.account.usage?.error ||
    five?.account.usage?.unsupported ||
    weekly?.account.usage?.error ||
    weekly?.account.usage?.unsupported ||
    (!five && accounts?.some((a) => a.usage?.error || a.usage?.unsupported)),
  );

  const fiveTitle = five && several ? `5-hour — ${accountName(five.account)}` : '5-hour window';
  const weeklyTitle =
    weekly && several
      ? `${bucketLabel(weekly.key)} — ${accountName(weekly.account)}`
      : weekly
        ? bucketLabel(weekly.key)
        : undefined;

  const trigger =
    variant === 'phone' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-(--tap-min) items-center gap-1 px-2 text-xs text-ink-muted"
        aria-label="Claude usage limits"
        title={fiveTitle}
      >
        <Gauge size={16} aria-hidden />
        {five ? <span>{Math.round(five.bucket.utilization)}%</span> : null}
      </button>
    ) : variant === 'sheet' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-(--tap-min) w-full items-center justify-between gap-2 text-sm"
      >
        <span className="flex items-center gap-2">
          <Gauge size={16} aria-hidden /> Usage limits
        </span>
        <span className="text-xs text-ink-muted">
          {five ? `5h ${Math.round(five.bucket.utilization)}%` : 'no data'}
        </span>
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised"
        aria-label="Claude usage limits"
        title={
          several ? 'Claude usage limits — the worst window across every account' : 'Claude usage limits'
        }
      >
        <span className="flex items-center gap-1 text-2xs uppercase tracking-wide text-ink-faint">
          <Gauge size={12} aria-hidden /> Usage
          {stale ? <span className="text-ink-faint">·&nbsp;stale</span> : null}
        </span>
        {five ? (
          <span
            className="flex items-center gap-1.5"
            title={`${fiveTitle} at ${Math.round(five.bucket.utilization)}%`}
          >
            <span className="w-4 text-2xs text-ink-faint">5h</span>
            <Meter pct={five.bucket.utilization} />
          </span>
        ) : (
          <span className="text-2xs text-ink-faint">no data yet</span>
        )}
        {weekly ? (
          <span
            className="flex items-center gap-1.5"
            title={`${weeklyTitle} at ${Math.round(weekly.bucket.utilization)}%`}
          >
            <span className="w-4 text-2xs text-ink-faint">wk</span>
            <Meter pct={weekly.bucket.utilization} />
          </span>
        ) : null}
      </button>
    );

  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Claude usage limits">
          <LimitsOverview accounts={data?.accounts} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Every account × every bucket, with resets and staleness. Reused by Settings. */
export function LimitsOverview({ accounts }: { accounts: AccountView[] | undefined }) {
  // The mute renders even with nothing to meter. A console with no REGISTERED
  // account still runs work as the default one, and still announces when that
  // hits a window — so "no accounts to meter yet" must not be a page with no
  // way to switch those announcements off.
  if (!accounts?.length) {
    return (
      <div className="flex flex-col gap-4">
        <Empty title="No accounts to meter yet" />
        <UsageAlerts />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {accounts.map((account) => {
        const buckets = Object.entries(account.usage?.buckets ?? {});
        const fetched = account.usage?.fetchedAt ? Date.parse(account.usage.fetchedAt) : undefined;
        return (
          <section key={account.id} className="flex flex-col gap-2">
            <header className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{accountName(account)}</span>
              {account.plan ? <Chip>{account.plan}</Chip> : null}
              {account.kind === 'token' ? <Chip>token</Chip> : null}
              {account.kind === 'profile' && account.signedIn === false ? <Chip>not signed in</Chip> : null}
              {account.authState === 'expired' ? <Chip tone="bad">login expired</Chip> : null}
              {account.authState === 'signed-out' && account.signedIn !== false ? (
                <Chip tone="bad">signed out</Chip>
              ) : null}
              {fetched !== undefined ? (
                <span className="text-2xs text-ink-faint">as of {relativeTime(fetched)}</span>
              ) : null}
            </header>
            {account.usage?.unsupported ? (
              <p className="text-xs text-ink-muted">
                The usage endpoint does not serve this credential — limits are learned when a run hits one.
              </p>
            ) : buckets.length ? (
              buckets.map(([key, bucket]) => (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span className="w-40 shrink-0 truncate text-ink-muted">{bucketLabel(key)}</span>
                  <Meter pct={bucket.utilization} className="flex-1" />
                  <span className="w-9 shrink-0 text-right">{Math.round(bucket.utilization)}%</span>
                  <span
                    className="w-20 shrink-0 truncate text-right text-ink-faint"
                    title={new Date(bucket.resetsAt).toLocaleString()}
                  >
                    {countdown(Date.parse(bucket.resetsAt)) || '—'}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-xs text-ink-faint">
                No usage data{account.usage?.error ? ` — ${account.usage.error}` : ' yet'}.
              </p>
            )}
            {Object.entries(account.limitedUntil ?? {}).map(([bucket, iso]) => (
              <p key={bucket} className="text-xs font-medium text-ink-muted">
                Hit its {bucketLabel(bucket).toLowerCase()} limit —{' '}
                {countdown(Date.parse(iso)) || 'reset due'} (
                {new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).
              </p>
            ))}
          </section>
        );
      })}

      <UsageAlerts />
    </div>
  );
}

/**
 * The mute, put where the noise is.
 *
 * The switch itself is not new — `notify.limits` has always been one of the
 * eleven categories on Notifications ▸ Settings, and the server gates on it
 * before the inbox record, the live event, `PHASE_CONSOLE_NOTIFY` and push
 * alike. What was missing is that nobody forms the intention "stop telling me
 * about usage" while reading a list of notification categories. They form it
 * looking at the meter that just buzzed them, which is here.
 *
 * So this is the same preference, written from the place the irritation
 * happens. It reads server state rather than keeping its own, because a
 * preference that governs a server process has to render what that process
 * holds — a local copy would show the operator their intention instead of the
 * setting.
 *
 * It says what stays audible, deliberately. The category also carries a run
 * that parked waiting for a window, an account that could not sign in, and a
 * run refused before it started — silence about those looks exactly like a
 * console that has stopped working.
 */
function UsageAlerts() {
  const client = useQueryClient();
  const { data: state } = useConsoleState();
  const on = state?.prefs?.notify?.limits !== false;

  const save = useMutation({
    // A delta, not the whole map: the server merges it over what is stored, so
    // two tabs toggling different categories do not overwrite each other.
    mutationFn: (next: boolean) => api.savePrefs({ notify: { limits: next } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.state() });
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (!state) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t border-rule pt-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Usage alerts</span>
        <Button
          size="sm"
          variant={on ? 'ghost' : 'default'}
          disabled={save.isPending}
          aria-pressed={on}
          onClick={() => save.mutate(!on)}
        >
          {on ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
      <p className="text-2xs text-ink-faint">
        {on
          ? 'The console announces a window that was hit, a run that parked waiting for one to ' +
            'reopen, and an account that could not sign in. Turning this off silences all of ' +
            'them everywhere — inbox, push and any notify command. The meters above keep ' +
            'updating, and the early "usage climbing" warning has its own switch under ' +
            'Notifications (off unless you turn it on).'
          : 'Silenced everywhere — inbox, push and any notify command. Runs still wait, switch ' +
            'account or pause as you asked; they just do it without telling you. The meters ' +
            'above keep updating.'}
      </p>
    </div>
  );
}
