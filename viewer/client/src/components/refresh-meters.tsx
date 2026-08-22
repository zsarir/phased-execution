/**
 * "Look again" — the one refresh control every usage panel offers.
 *
 * Three surfaces show Claude usage (the header meter's dialog, Settings ▸
 * Accounts, and the account field of a launch form) and until now only one of
 * them could ask for fresher numbers. Worse, the ask did not work: the server
 * kicked its poller and answered from the cache the poll had not replaced yet,
 * so the button returned the same figures it was pressed to replace. Both
 * halves are fixed — `POST /api/accounts/refresh` now AWAITS the poll — and
 * this is the control, written once so the three panels cannot drift into
 * three different affordances again.
 *
 * With no `accountId` it re-reads EVERY account in one request, which is the
 * question an operator actually has ("is anything free right now?") and one
 * round of the endpoint's courtesy budget rather than N.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button, toast } from '@/components/ui';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { cn } from '@/lib/cn';

export function RefreshMeters({
  accountId,
  size = 'sm',
  variant = 'default',
  label,
  className,
}: {
  /** One account, or every account when absent. */
  accountId?: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'ghost';
  /** Override the words; the icon alone is never enough on its own. */
  label?: string;
  className?: string;
}) {
  const client = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api.accountRefresh(accountId),
    onSuccess: async () => {
      // Both: `accounts` is the meters, `state` is the header's copy of them.
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.accounts() }),
        client.invalidateQueries({ queryKey: keys.state() }),
      ]);
      toast(accountId ? 'Re-read this account.' : 'Re-read every account.', 'ok');
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  return (
    <Button
      size={size}
      variant={variant}
      className={cn(className)}
      disabled={refresh.isPending}
      title={
        accountId
          ? 'Ask Claude for this account’s current usage now.'
          : 'Ask Claude for every account’s current usage now.'
      }
      onClick={() => refresh.mutate()}
    >
      <RefreshCw size={13} className={cn(refresh.isPending && 'animate-spin')} aria-hidden />
      {refresh.isPending ? 'Reading…' : (label ?? (accountId ? 'Refresh' : 'Refresh all'))}
    </Button>
  );
}
