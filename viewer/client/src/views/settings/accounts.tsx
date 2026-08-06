/**
 * Claude accounts — this INSTANCE's registration system.
 *
 * Each console keeps its own registry (a per-instance fact, like its push
 * keys): the machine login is always row one, profiles are directories the
 * operator signs into, tokens are pasted from `claude setup-token`. The card
 * shows the meters beside the identities because that is the question the
 * registry exists to answer — which login has quota left for the next run.
 *
 * Registration is gated by `--allow-accounts`; READING is not. On a console
 * without the flag the card still meters the machine login and says what the
 * flag would add — a capability that hides when disabled looks like a bug.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { keys, useAccounts, useConsoleState } from '@/lib/queries';
import { api, type AccountLoginStart } from '@/lib/api';
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Dialog, DialogContent,
  Skeleton, copy, toast,
} from '@/components/ui';
import { LimitsOverview } from '@/components/limits-widget';
import { navigate } from '@/router';

export function AccountsCard() {
  const client = useQueryClient();
  const { data, isPending } = useAccounts();
  const { data: state } = useConsoleState();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [loginName, setLoginName] = useState('');

  const invalidate = () => client.invalidateQueries({ queryKey: keys.accounts() });

  const startLogin = useMutation({
    mutationFn: (body: { accountId?: string; name?: string }) => api.accountLogin(body),
    onSuccess: (started: AccountLoginStart) => {
      void invalidate();
      setLoginName('');
      if (started.mode === 'embedded' && started.terminal) {
        toast('Sign in inside the terminal that just opened.', 'info');
        navigate(`agent/${started.terminal.sessionId}`);
      } else if (started.mode === 'external') {
        toast('A terminal opened — finish `claude auth login` there, then Refresh.', 'info');
      } else {
        void copy(started.command, 'Command copied — run it in any terminal, then Refresh');
      }
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const addToken = useMutation({
    mutationFn: () => api.accountAdd(name.trim(), token.trim()),
    onSuccess: () => {
      setAdding(false);
      setName('');
      setToken('');
      void invalidate();
      toast('Account added. Its meters appear once the endpoint answers.', 'ok');
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.accountDelete(id),
    onSuccess: () => { void invalidate(); },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const refresh = useMutation({
    mutationFn: (id?: string) => api.accountRefresh(id),
    onSuccess: () => { void invalidate(); },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  if (isPending && !data) return <Skeleton className="h-64" />;

  const allowed = data?.allowAccounts ?? state?.allowAccounts ?? false;
  const accounts = data?.accounts ?? [];
  const busy = startLogin.isPending || addToken.isPending || remove.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Claude accounts</CardTitle>
        {allowed ? <Chip tone="warn">registration enabled</Chip> : null}
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <LimitsOverview accounts={accounts} />

        {allowed
          ? (
            <div className="flex flex-col gap-3 border-t border-rule pt-3">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                  <span className="text-2xs uppercase tracking-wide text-ink-faint">Sign another account in</span>
                  <input
                    value={loginName}
                    onChange={(event) => setLoginName(event.target.value)}
                    placeholder="a name for it — work, personal…"
                    className="rounded border border-rule bg-surface px-2 py-1.5"
                  />
                </label>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => startLogin.mutate(loginName.trim() ? { name: loginName.trim() } : {})}
                >
                  Sign in…
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(true)}>
                  Paste a token…
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                {accounts.filter((a) => !a.builtIn).map((account) => (
                  <span key={account.id} className="flex items-center gap-1 rounded border border-rule px-2 py-1 text-xs">
                    <span className="max-w-40 truncate">{account.name ?? account.email ?? account.id}</span>
                    {account.kind === 'profile' && account.signedIn === false
                      ? (
                        <Button size="sm" variant="ghost" disabled={busy}
                          onClick={() => startLogin.mutate({ accountId: account.id })}>
                          Sign in
                        </Button>
                      )
                      : null}
                    <Button size="sm" variant="ghost" disabled={busy}
                      onClick={() => refresh.mutate(account.id)}>
                      Refresh
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy}
                      onClick={() => remove.mutate(account.id)}>
                      Remove
                    </Button>
                  </span>
                ))}
              </div>
            </div>
          )
          : (
            <p className="border-t border-rule pt-3 text-xs text-ink-muted">
              Start the console with <code>--allow-accounts</code> to sign additional Claude accounts in
              (or paste <code>claude setup-token</code> tokens) and pick an account per run. The meters
              above work without it.
            </p>
          )}
      </CardBody>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent
          title="Add a token account"
          description="Run `claude setup-token` in any terminal signed into the account, then paste the token it prints. The name is required — a token carries no email to show."
        >
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="spare max account"
                className="rounded border border-rule bg-surface px-2 py-1.5"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Token</span>
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="sk-ant-oat01-…"
                type="password"
                autoComplete="off"
                className="rounded border border-rule bg-surface px-2 py-1.5 font-mono"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button disabled={!name.trim() || !token.trim() || addToken.isPending} onClick={() => addToken.mutate()}>
                Add account
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
