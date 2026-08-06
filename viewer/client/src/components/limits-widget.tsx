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

import { useAccounts } from '@/lib/queries';
import type { AccountView, UsageBucket } from '@/lib/api';
import { countdown, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Chip, Dialog, DialogContent, Empty } from '@/components/ui';

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
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-track', className)} role="img"
      aria-label={`${Math.round(clamped)}% used`}>
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

/** The account the compact meters describe: the machine login, by design. */
function headline(accounts: AccountView[] | undefined): AccountView | undefined {
  return accounts?.find((a) => a.id === 'default') ?? accounts?.[0];
}

function accountName(account: AccountView): string {
  if (account.builtIn) return account.email ?? 'This machine’s login';
  return account.name ?? account.email ?? account.id;
}

export function LimitsWidget({ variant }: { variant: 'rail' | 'phone' | 'sheet' }) {
  const [open, setOpen] = useState(false);
  const { data } = useAccounts();
  const account = headline(data?.accounts);
  const five = account?.usage?.buckets.five_hour;
  const weekly = worstWeekly(account);

  const trigger = variant === 'phone'
    ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-(--tap-min) items-center gap-1 px-2 text-xs text-ink-muted"
        aria-label="Claude usage limits"
      >
        <Gauge size={16} aria-hidden />
        {five ? <span>{Math.round(five.utilization)}%</span> : null}
      </button>
    )
    : variant === 'sheet'
      ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-h-(--tap-min) w-full items-center justify-between gap-2 text-sm"
        >
          <span className="flex items-center gap-2"><Gauge size={16} aria-hidden /> Usage limits</span>
          <span className="text-xs text-ink-muted">
            {five ? `5h ${Math.round(five.utilization)}%` : 'no data'}
          </span>
        </button>
      )
      : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-raised"
          aria-label="Claude usage limits"
          title="Claude usage limits"
        >
          <span className="flex items-center gap-1 text-2xs uppercase tracking-wide text-ink-faint">
            <Gauge size={12} aria-hidden /> Usage
            {account?.usage?.error || account?.usage?.unsupported
              ? <span className="text-ink-faint">·&nbsp;stale</span> : null}
          </span>
          {five
            ? (
              <span className="flex items-center gap-1.5">
                <span className="w-4 text-2xs text-ink-faint">5h</span>
                <Meter pct={five.utilization} />
              </span>
            )
            : <span className="text-2xs text-ink-faint">no data yet</span>}
          {weekly
            ? (
              <span className="flex items-center gap-1.5">
                <span className="w-4 text-2xs text-ink-faint">wk</span>
                <Meter pct={weekly.bucket.utilization} />
              </span>
            )
            : null}
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
  if (!accounts?.length) return <Empty title="No accounts to meter yet" />;
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
              {fetched !== undefined
                ? <span className="text-2xs text-ink-faint">as of {relativeTime(fetched)}</span>
                : null}
            </header>
            {account.usage?.unsupported
              ? (
                <p className="text-xs text-ink-muted">
                  The usage endpoint does not serve this credential — limits are learned when a run hits one.
                </p>
              )
              : buckets.length
                ? buckets.map(([key, bucket]) => (
                  <div key={key} className="flex items-center gap-2 text-xs">
                    <span className="w-40 shrink-0 truncate text-ink-muted">{bucketLabel(key)}</span>
                    <Meter pct={bucket.utilization} className="flex-1" />
                    <span className="w-9 shrink-0 text-right">{Math.round(bucket.utilization)}%</span>
                    <span className="w-20 shrink-0 truncate text-right text-ink-faint" title={new Date(bucket.resetsAt).toLocaleString()}>
                      {countdown(Date.parse(bucket.resetsAt)) || '—'}
                    </span>
                  </div>
                ))
                : <p className="text-xs text-ink-faint">No usage data{account.usage?.error ? ` — ${account.usage.error}` : ' yet'}.</p>}
            {Object.entries(account.limitedUntil ?? {}).map(([bucket, iso]) => (
              <p key={bucket} className="text-xs font-medium text-ink-muted">
                Hit its {bucketLabel(bucket).toLowerCase()} limit — {countdown(Date.parse(iso)) || 'reset due'}
                {' '}({new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).
              </p>
            ))}
          </section>
        );
      })}
    </div>
  );
}
