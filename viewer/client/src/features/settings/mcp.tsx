/**
 * MCP servers — what this instance's sessions may connect to.
 *
 * Two halves, because they answer two different questions. **Registry** is
 * "what do I have, and is it working" — the one a person opens when a phase
 * parked. **Catalog** is "what could I have" — the one they open once, when
 * setting a machine up. The catalog lives in its own module (`./mcp-catalog`).
 *
 * Registration is gated by `--allow-mcp`; READING is not. Without the flag the
 * section still shows the registry, the statuses and the catalog, and says what
 * the flag would add — a capability that hides when disabled looks like a bug.
 *
 * The section is deliberately opinionated about restraint. Every attached
 * server costs context on every turn and adds tool names that can collide, so
 * the header states the working range rather than leaving people to discover
 * it, and a phase's own call counts (on the run page) are what settle the
 * argument.
 *
 * 3.0 folded `#/mcp` and `#/mcp/catalog` in here (`#/settings/mcp` and
 * `?tab=catalog`). The tab is a QUERY value rather than a path segment because
 * `#/settings/:section` is the address space now: a second segment would mean
 * every section could invent its own sub-path vocabulary, and the redirect that
 * carries the old links needs somewhere to put the half of the address that
 * survived — the `#/ready` → `?focus=next` rule.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { keys, useMcp } from '@/lib/queries';
import { api, type McpServerView } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import {
  AlertDialog,
  AlertDialogContent,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Chip,
  Dialog,
  DialogContent,
  Empty,
  Skeleton,
  copy,
  toast,
} from '@/components/ui';
import { navigate } from '@/app/router';
import type { Route } from '@/app/router';
import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { SettingsSectionFrame, sectionFor } from './nav';
import { Catalog } from './mcp-catalog';

/** How many servers is a working number, per the ecosystem's own experience. */
const COMFORTABLE = 6;

/** The one control class this half needs — see `ui/field.ts` for the rule. */
const field = 'w-full rounded-md border border-rule bg-surface px-2 py-1.5 text-sm';

export function McpSection({ route }: { route: Route }) {
  const section = sectionFor('mcp')!;
  const tab = route.query.tab === 'catalog' ? 'catalog' : 'registry';
  const { data, isPending } = useMcp();
  const servers = data?.servers ?? [];
  const allowed = data?.allowMcp ?? false;

  const refresh = useMutation({
    mutationFn: () => api.mcpRefresh(),
    onSuccess: () => toast('Re-checked every enabled server.', 'ok'),
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const attached = servers.filter((server) => server.enabled);
  const attention = attached.filter(needsAttention);

  return (
    <SettingsSectionFrame section={section}>
      {attention.length > 0 && (
        <Banner severity="error">
          {attention.length === 1
            ? `${attention[0].label} needs attention — any phase naming it will park at boarding.`
            : `${attention.length} servers need attention — phases naming them will park at boarding.`}
        </Banner>
      )}

      <Tabs.Root
        value={tab}
        onValueChange={(next) => navigate(next === 'catalog' ? 'settings/mcp?tab=catalog' : 'settings/mcp')}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule">
          <Tabs.List className="flex min-w-0 gap-1">
            {(['registry', 'catalog'] as const).map((id) => (
              <Tabs.Trigger
                key={id}
                value={id}
                className="-mb-px min-h-(--tap-min) border-b-2 border-transparent px-3 py-1.5 text-sm text-ink-muted
                  data-[state=active]:border-accent data-[state=active]:text-ink"
              >
                {id === 'registry' ? `Registered (${servers.length})` : 'Catalog'}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Button
            size="sm"
            className="mb-1.5 shrink-0"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || !attached.length}
          >
            {refresh.isPending ? 'Checking…' : 'Re-check all'}
          </Button>
        </div>

        <Tabs.Content value="registry" className="mt-3">
          {isPending ? (
            <div className="grid gap-3">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          ) : (
            <Registry servers={servers} allowed={allowed} />
          )}
        </Tabs.Content>

        <Tabs.Content value="catalog" className="mt-3">
          <Catalog allowed={allowed} registered={new Set(servers.map((server) => server.id))} />
        </Tabs.Content>
      </Tabs.Root>
    </SettingsSectionFrame>
  );
}
function needsAttention(server: McpServerView): boolean {
  return server.status === 'needs-auth' || server.status === 'failed' || Boolean(server.toolsChanged);
}

/* ---------------- registry ---------------- */

function Registry({ servers, allowed }: { servers: McpServerView[]; allowed: boolean }) {
  const attached = servers.filter((server) => server.enabled).length;

  if (!servers.length) {
    return (
      <>
        <Empty
          title="No MCP servers registered"
          body="Sessions here run with whatever MCP configuration this machine already has. Register a
                server to attach it deliberately — to a plan, to a run, or to one phase."
        />
        {!allowed && <FlagNote />}
      </>
    );
  }

  return (
    <>
      {attached > COMFORTABLE && (
        <Banner severity="warn" className="mb-3">
          {attached} servers are switched on. Every one of them costs context on every turn and adds tool
          names that can collide with another server's — three to six is the range people settle at. The run
          page shows which ones a phase actually called.
        </Banner>
      )}
      <div className="grid gap-3">
        {servers.map((server) => (
          <ServerCard key={server.id} server={server} allowed={allowed} />
        ))}
      </div>
      {!allowed && <FlagNote />}
    </>
  );
}

function FlagNote() {
  return (
    <p className="mt-3 border-t border-rule pt-3 text-xs text-ink-muted">
      Start the console with <code>--allow-mcp</code> to register servers, hold their credentials and attach
      them to plans. Reading the registry, the statuses and the catalog works without it.
    </p>
  );
}

function ServerCard({ server, allowed }: { server: McpServerView; allowed: boolean }) {
  const client = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const [secretFor, setSecretFor] = useState<string | null>(null);
  const [secret, setSecret] = useState('');

  const invalidate = () => client.invalidateQueries({ queryKey: keys.mcp() });
  const fail = (error: Error) => toast(String(error.message ?? error), 'error');

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.mcpPatch(server.id, { enabled }),
    onSuccess: () => {
      void invalidate();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.mcpDelete(server.id),
    onSuccess: () => {
      setRemoving(false);
      void invalidate();
      toast(`${server.label} removed, with anything it held.`, 'ok');
    },
    onError: fail,
  });
  const login = useMutation({
    mutationFn: () => api.mcpLogin(server.id),
    onSuccess: (started) => {
      void invalidate();
      if (started.mode === 'embedded' && started.terminal) {
        toast('Finish the sign-in in the terminal that just opened.', 'info');
        navigate(`sessions/${started.terminal.sessionId}`);
      } else if (started.mode === 'external') {
        toast('A terminal opened — finish the sign-in there.', 'info');
      } else {
        void copy(started.command, 'Command copied — run it in any terminal, then Re-check');
      }
    },
    onError: fail,
  });
  const setSecretValue = useMutation({
    mutationFn: (ref: string) => {
      const [kind, ...rest] = ref.split(':');
      return api.mcpPatch(server.id, {
        secretRef: { kind, name: rest.join(':') },
        secret: secret.trim(),
      });
    },
    onSuccess: () => {
      setSecretFor(null);
      setSecret('');
      void invalidate();
      toast('Stored. Re-checking the connection…', 'ok');
      void api.mcpRefresh().catch(() => {
        /* the card will say if it did not help */
      });
    },
    onError: fail,
  });
  const acknowledge = useMutation({
    mutationFn: () => api.mcpAcknowledge(server.id),
    onSuccess: () => {
      void invalidate();
    },
    onError: fail,
  });

  return (
    <Card className={server.enabled ? undefined : 'opacity-60'}>
      <CardHeader>
        <CardTitle>
          {server.label}
          <code className="ml-2 text-xs font-normal text-ink-faint">{server.id}</code>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip server={server} />
          <Chip>{server.transport}</Chip>
          {server.toolCount ? <Chip>{server.toolCount} tools</Chip> : null}
        </div>
      </CardHeader>

      <CardBody className="grid gap-2 text-sm">
        <p className="truncate text-xs text-ink-muted">
          <code>{server.url ?? server.command}</code>
        </p>

        {server.issue && <Banner severity="error">{server.issue}</Banner>}

        {server.toolsChanged && (
          <Banner severity="warn">
            <p>
              This server now advertises different tools than it did{' '}
              {relativeTime(Date.parse(server.toolsChanged.seenAt))}.
              {server.toolsChanged.added.length ? ` Added: ${server.toolsChanged.added.join(', ')}.` : ''}
              {server.toolsChanged.removed.length
                ? ` Removed: ${server.toolsChanged.removed.join(', ')}.`
                : ''}
            </p>
            <p className="mt-1">
              A server whose tools change under you is how a trusted integration becomes an untrusted one.
              Check what changed before the next run attaches it.
            </p>
            <Button size="sm" className="mt-2" onClick={() => acknowledge.mutate()}>
              I have checked it
            </Button>
          </Banner>
        )}

        {server.interactiveTools?.length ? (
          <Banner severity="warn">
            {server.interactiveTools.join(', ')} require a person to approve every call, which an unattended
            run can never do. A phase that needs{' '}
            {server.interactiveTools.length === 1 ? 'that tool' : 'those tools'} will stall rather than
            finish.
          </Banner>
        ) : null}

        {server.auth.secrets.map((held) => (
          <p key={held.ref} className="text-xs text-ink-muted">
            <code>{held.ref}</code> — {held.held ? 'held in the keychain' : 'not set'}
            {allowed && (
              <Button
                size="sm"
                className="ml-2"
                onClick={() => {
                  setSecretFor(held.ref);
                  setSecret('');
                }}
              >
                {held.held ? 'Replace' : 'Set'}
              </Button>
            )}
          </p>
        ))}

        <p className="text-xs text-ink-faint">
          {server.checkedAt ? `Checked ${relativeTime(Date.parse(server.checkedAt))}` : 'Never checked'}
          {server.lastUsed ? ` · last used ${relativeTime(Date.parse(server.lastUsed))}` : ''}
        </p>

        {allowed && (
          <div className="flex flex-wrap gap-2 border-t border-rule pt-2">
            <Button size="sm" onClick={() => toggle.mutate(!server.enabled)} disabled={toggle.isPending}>
              {server.enabled ? 'Switch off' : 'Switch on'}
            </Button>
            {server.transport !== 'stdio' && server.auth.kind === 'oauth' && (
              <Button size="sm" onClick={() => login.mutate()} disabled={login.isPending}>
                {server.status === 'connected' ? 'Sign in again' : 'Sign in'}
              </Button>
            )}
            <Button size="sm" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </div>
        )}
      </CardBody>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent
          title={`Remove ${server.label}?`}
          confirmLabel="Remove server"
          cancelLabel="Keep it"
          destructive
          onConfirm={() => remove.mutate()}
        >
          <p className="text-sm">
            The registration and anything this console holds for it — keychain entries, stored headers — are
            deleted. Any plan that names <code>{server.id}</code> will park at boarding until it is registered
            again or the name is dropped from the plan.
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            An OAuth sign-in stays where it is: <code>claude mcp logout {server.id}</code> is what clears
            that, because the CLI owns it and this console never writes to its credential store.
          </p>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={secretFor !== null}
        onOpenChange={(open) => {
          if (!open) setSecretFor(null);
        }}
      >
        <DialogContent title={`Set ${secretFor ?? ''}`}>
          <p className="text-sm text-ink-muted">
            Stored in this machine's keychain, never in the registry file and never shown again.
          </p>
          <input
            className={`${field} mt-2`}
            type="password"
            autoFocus
            value={secret}
            placeholder="Paste the token"
            onChange={(event) => setSecret(event.target.value)}
          />
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={!secret.trim() || setSecretValue.isPending}
              onClick={() => secretFor && setSecretValue.mutate(secretFor)}
            >
              Store it
            </Button>
            <Button size="sm" onClick={() => setSecretFor(null)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * The status, in the words the CLI itself uses.
 *
 * `pending` is deliberately not an alarm: a remote server with a cached tool
 * list reports pending and connects on its first tool call, which is normal.
 */
function StatusChip({ server }: { server: McpServerView }) {
  if (!server.enabled) return <Chip>switched off</Chip>;
  switch (server.status) {
    case 'connected':
      return <Chip tone="ok">connected</Chip>;
    case 'needs-auth':
      return <Chip tone="bad">needs sign-in</Chip>;
    case 'failed':
      return <Chip tone="bad">will not connect</Chip>;
    case 'pending':
      return <Chip>connects on first use</Chip>;
    default:
      return <Chip>not checked</Chip>;
  }
}
