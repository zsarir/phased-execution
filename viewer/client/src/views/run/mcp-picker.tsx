/**
 * Which MCP servers a run — or one phase of it — attaches.
 *
 * The same shape as `SkillPicker`, and for the same reasons: a `<details>` so
 * it costs nothing when nobody is choosing, chosen items pinned to the top, and
 * what the PLAN already asked for shown as a fact rather than as a checkbox.
 * A plan's `**MCP servers (every session):**` line and a phase's `**MCP:**`
 * bullet are versioned statements about what the work needs; unticking one here
 * would be the console overruling the repository, which is not a thing this
 * console does anywhere else.
 *
 * What it adds over the skill picker is honesty about state. A server that is
 * signed out or switched off cannot be attached, and finding that out at
 * boarding — after the queue, the lock and the gate — is exactly the failure
 * the preflight exists to prevent. So an unusable server is shown, disabled,
 * with the reason next to it.
 */

import { useMemo, useState } from 'react';

import type { McpServerView } from '@/lib/api';
import { Chip } from '@/components/ui';

/** Past this, the context cost stops being noise. Same number the MCP page uses. */
const COMFORTABLE = 6;

export function McpPicker({
  servers,
  chosen,
  planServers = [],
  onChange,
  label = 'MCP servers for this run',
  note,
}: {
  servers: McpServerView[];
  chosen: string[];
  /** What the plan already names — shown, never unticked from here. */
  planServers?: string[];
  onChange: (next: string[]) => void;
  label?: string;
  note?: string;
}) {
  const [open, setOpen] = useState(false);

  // Chosen first, then everything usable, then what cannot be attached — so the
  // list reads as "what you picked / what you could pick / what is broken".
  const ordered = useMemo(() => {
    const rank = (server: McpServerView) => {
      if (chosen.includes(server.id)) return 0;
      return usable(server) ? 1 : 2;
    };
    return [...servers].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }, [servers, chosen]);

  const total = new Set([...planServers, ...chosen]).size;

  if (!servers.length) return null;

  const toggle = (id: string) => {
    onChange(chosen.includes(id) ? chosen.filter((held) => held !== id) : [...chosen, id]);
  };

  return (
    <details
      className="rounded-md border border-rule"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer px-2 py-1.5 text-sm">
        <span className="text-2xs uppercase tracking-wide text-ink-faint">{label}</span>
        {total > 0 && <span className="ml-2 text-ink-muted">{total} attached</span>}
      </summary>

      <div className="grid gap-1.5 border-t border-rule p-2">
        {note && <p className="text-2xs text-ink-faint">{note}</p>}

        {planServers.length > 0 && (
          <p className="text-2xs text-ink-faint">
            The plan already attaches{' '}
            {planServers.map((id) => (
              <code key={id} className="mr-1">
                {id}
              </code>
            ))}
            — every phase gets those whatever is ticked here.
          </p>
        )}

        {total > COMFORTABLE && (
          <p className="text-2xs text-stuck">
            {total} servers is more than most runs want. Each one costs context on every turn.
          </p>
        )}

        {ordered.map((server) => {
          const ok = usable(server);
          const fromPlan = planServers.includes(server.id);
          return (
            <label
              key={server.id}
              className={`flex items-start gap-2 text-sm ${ok || fromPlan ? '' : 'opacity-60'}`}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={fromPlan || chosen.includes(server.id)}
                disabled={fromPlan || !ok}
                onChange={() => toggle(server.id)}
              />
              <span className="min-w-0">
                <span className="text-ink">{server.label}</span>
                <code className="ml-1.5 text-2xs text-ink-faint">{server.id}</code>
                {fromPlan && <Chip className="ml-1.5">from the plan</Chip>}
                {!ok && <span className="ml-1.5 text-2xs text-stuck">{whyNot(server)}</span>}
                {/* Tickable, but do not let it read as verified: nobody has
                    asked this one whether it works. */}
                {ok && unchecked(server) && (
                  <span className="ml-1.5 text-2xs text-ink-muted">not checked yet</span>
                )}
                {server.toolCount ? (
                  <span className="ml-1.5 text-2xs text-ink-faint">{server.toolCount} tools</span>
                ) : null}
              </span>
            </label>
          );
        })}

        {ordered.some(unchecked) && (
          <p className="text-2xs text-ink-faint">
            A server nobody has probed can still be ticked — its status simply is not known yet. Check them
            from the MCP page if it matters; a phase that boards with one it cannot reach runs without it and
            says so, unless the plan requires it.
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * Could a phase actually board with this? `pending` can — it connects on first
 * use — and a server nobody has probed yet might, so neither is refused here.
 *
 * A registration nobody finished is refused: an unfilled `${VAR}` in the
 * command will never connect, however many times it is probed, so offering it
 * as a choice is offering something that cannot work.
 */
function usable(server: McpServerView): boolean {
  return (
    server.enabled &&
    !server.needsConfig?.length &&
    server.status !== 'needs-auth' &&
    server.status !== 'failed'
  );
}

/**
 * Has anybody actually asked this server whether it works?
 *
 * `unknown` is what a server reports before its first probe, and this control
 * used to treat it as fine — so an operator ticking six servers in the launch
 * dialog saw six tickable rows and learned the truth at boarding, after the
 * queue and the lock. That is exactly the failure this picker's own header says
 * it exists to prevent, arriving through the one status it did not check.
 */
function unchecked(server: McpServerView): boolean {
  return server.enabled && !server.needsConfig?.length && server.status === 'unknown';
}

function whyNot(server: McpServerView): string {
  if (!server.enabled) return 'switched off';
  if (server.needsConfig?.length) return `needs ${server.needsConfig.join(', ')}`;
  if (server.status === 'needs-auth') return 'needs signing in';
  return 'will not connect';
}
