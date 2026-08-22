/**
 * The MCP catalog — "what could I have", as opposed to the registry's "what do
 * I have, and is it working".
 *
 * Its own module because the two halves of `#/settings/mcp` are opened by two
 * different people at two different times: the registry when a phase parked,
 * the catalog once, when a machine is being set up. Splitting them is also what
 * keeps the search box, its debounce and the add dialog out of the chunk the
 * first half needs.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { keys, useMcpCatalog } from '@/lib/queries';
import { api, type McpCatalogEntry } from '@/lib/api';
import {
  Banner,
  Button,
  Card,
  CardBody,
  Chip,
  Dialog,
  DialogContent,
  Empty,
  Skeleton,
  copy,
  toast,
} from '@/components/ui';

/** The one control class this half needs — see `ui/field.ts` for the rule. */
const field = 'w-full rounded-md border border-rule bg-surface px-2 py-1.5 text-sm';

export function Catalog({ allowed, registered }: { allowed: boolean; registered: Set<string> }) {
  const [query, setQuery] = useState('');
  const { data, isFetching } = useMcpCatalog(query);
  const [adding, setAdding] = useState<McpCatalogEntry | null>(null);

  const entries = data?.entries ?? [];
  const groups = new Map<string, McpCatalogEntry[]>();
  for (const entry of entries) {
    groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);
  }

  return (
    <div className="grid gap-3">
      <input
        className={field}
        value={query}
        placeholder="Search — try github, browser, database, docs"
        onChange={(event) => setQuery(event.target.value)}
      />

      {data?.registryError && (
        <Banner severity="warn">
          The official registry could not be reached ({data.registryError}), so this is the curated list only.
          Everything below still works.
        </Banner>
      )}

      <p className="text-xs text-ink-muted">
        Keep the attached set small — three to six. Every server costs context on every turn, and a server you
        add is a server whose tool descriptions enter your prompts: only connect ones you would trust with the
        repository this console is pointed at.
      </p>

      {isFetching && !entries.length ? <Skeleton className="h-24" /> : null}

      {[...groups].map(([category, items]) => (
        <section key={category}>
          <h2 className="mb-1.5 text-2xs uppercase tracking-wide text-ink-faint">{category}</h2>
          <div className="grid gap-2">
            {items.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                allowed={allowed}
                already={registered.has(entry.id)}
                onAdd={() => setAdding(entry)}
              />
            ))}
          </div>
        </section>
      ))}

      {!isFetching && !entries.length && (
        <Empty title="Nothing matched" body="Try a shorter search, or a product name." />
      )}

      {adding && <AddDialog entry={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function CatalogRow({
  entry,
  allowed,
  already,
  onAdd,
}: {
  entry: McpCatalogEntry;
  allowed: boolean;
  already: boolean;
  onAdd: () => void;
}) {
  return (
    <Card>
      <CardBody className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{entry.label}</span>
          <code className="text-xs text-ink-faint">{entry.id}</code>
          <Chip>{entry.transport}</Chip>
          {entry.auth !== 'none' && <Chip>{authLabel(entry.auth)}</Chip>}
          {entry.source === 'registry' && <Chip tone="warn">from the registry</Chip>}
        </div>
        <p className="text-sm text-ink-muted">{entry.description}</p>
        {entry.authNote && <p className="text-xs text-ink-faint">{entry.authNote}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {already ? (
            <Chip tone="ok">registered</Chip>
          ) : allowed ? (
            <Button size="sm" onClick={onAdd}>
              Add
            </Button>
          ) : (
            <span className="text-xs text-ink-faint">
              needs <code>--allow-mcp</code>
            </span>
          )}
          {entry.homepage && (
            <a className="text-xs underline" href={entry.homepage} target="_blank" rel="noreferrer">
              docs
            </a>
          )}
          <Button size="sm" onClick={() => void copy(addCommand(entry), 'Command copied')}>
            Copy CLI command
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function authLabel(auth: McpCatalogEntry['auth']): string {
  if (auth === 'oauth') return 'sign-in';
  if (auth === 'header') return 'needs a token';
  return 'needs an env var';
}

/** The equivalent `claude mcp add`, so somebody can do it outside the console. */
function addCommand(entry: McpCatalogEntry): string {
  if (entry.transport === 'stdio') {
    return `claude mcp add ${entry.id} -- ${entry.command} ${(entry.args ?? []).join(' ')}`.trim();
  }
  return `claude mcp add --transport ${entry.transport} ${entry.id} ${entry.url ?? ''}`.trim();
}

function AddDialog({ entry, onClose }: { entry: McpCatalogEntry; onClose: () => void }) {
  const client = useQueryClient();
  const [secret, setSecret] = useState('');
  const ref = entry.secretRefs?.[0];

  const add = useMutation({
    mutationFn: () =>
      api.mcpAdd({
        id: entry.id,
        label: entry.label,
        transport: entry.transport,
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.secretRefs ? { secretRefs: entry.secretRefs } : {}),
        ...(ref && secret.trim() ? { secrets: { [`${ref.kind}:${ref.name}`]: secret.trim() } } : {}),
        source: 'catalog',
      }),
    onSuccess: () => {
      onClose();
      void client.invalidateQueries({ queryKey: keys.mcp() });
      toast(
        entry.auth === 'oauth'
          ? `${entry.label} registered — sign it in from the Registered tab.`
          : `${entry.label} registered. Checking the connection…`,
        'ok',
      );
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title={`Add ${entry.label}`}>
        <p className="text-sm text-ink-muted">{entry.description}</p>
        <p className="mt-2 text-xs text-ink-faint">
          It registers as <code>{entry.id}</code> — the name a plan uses on its
          <code> **MCP servers (every session):** </code> line, and the name a permission rule uses as{' '}
          <code>mcp__{entry.id}</code>.
        </p>

        {entry.auth === 'oauth' && (
          <p className="mt-2 text-sm">
            Signs in with OAuth. Register it now, then use Sign in — the token goes to the Claude CLI's own
            store, which this console never reads or writes.
          </p>
        )}
        {entry.authNote && <p className="mt-2 text-sm">{entry.authNote}</p>}

        {ref && (
          <label className="mt-2 block text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">{ref.name}</span>
            <input
              className={`${field} mt-1`}
              type="password"
              autoFocus
              value={secret}
              placeholder="Paste the token — stored in this machine's keychain"
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
        )}

        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add server'}
          </Button>
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
