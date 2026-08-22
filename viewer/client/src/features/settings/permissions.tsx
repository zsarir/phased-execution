/**
 * What an unattended session may do — and, the part that matters, **which layer
 * actually stops it**.
 *
 * These three lists look alike and are nothing alike:
 *
 *   `deny`  is evaluated inside the CLI with no network involved, and was
 *           measured holding with this console stopped. It is the wall.
 *   `ask`   goes through the HTTP hook, and **that hook fails open** — with
 *           nothing listening the tool call simply proceeds.
 *   `allow` never round-trips at all, and the ones *you* add outrank `ask`.
 *
 * Presenting them as one list would be the most dangerous thing this page could
 * do, so the difference is the first thing said about each.
 *
 * The builder exists for the same reason. A free-text box assumes the writer
 * remembers that `:*` only works at the end, that `ls *` and `ls*` are different
 * rules, and that `Write(…)` paths are silently ignored. Almost nobody does.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api, type PolicyLists } from '@/lib/api';
import { keys, useConsoleState, usePlans, usePolicy } from '@/lib/queries';
import { SettingsSectionFrame, sectionFor } from './nav';
import {
  AlertDialog,
  AlertDialogContent,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  toast,
} from '@/components/ui';

/** The rule forms, and what each one builds. */
const FORMS = [
  {
    id: 'prefix',
    label: 'Command prefix',
    tool: 'Bash',
    placeholder: 'git commit',
    build: (tool: string, value: string) => `${tool}(${value}:*)`,
    hint: 'Matches the command and anything after it, at a word boundary. Bash(ls:*) is Bash(ls *) — it does not match lsof.',
  },
  {
    id: 'glob',
    label: 'Command glob',
    tool: 'Bash',
    placeholder: 'npm run test *',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: '* spans anything. Mind the space: `ls *` is not `ls*`.',
  },
  {
    id: 'tool',
    label: 'A whole tool',
    tool: 'WebFetch',
    placeholder: '',
    build: (tool: string) => tool,
    hint: 'Every use of that tool. As a deny rule, this removes the tool from the session entirely.',
  },
  {
    id: 'param',
    label: 'One parameter',
    tool: 'Agent',
    placeholder: 'model:opus',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: 'One parameter per rule; * is allowed in the value. Bash(command:…) is NOT one of these — it is ignored.',
  },
  {
    id: 'path',
    label: 'A path',
    tool: 'Read',
    placeholder: '~/.ssh/**',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: '//abs · ~/home · ./cwd · a bare name means anywhere, so Read(.env) is Read(**/.env). Only Read(…) and Edit(…) are consulted.',
  },
  {
    id: 'domain',
    label: 'A web domain',
    tool: 'WebFetch',
    placeholder: '*.example.com',
    build: (tool: string, value: string) => `${tool}(domain:${value})`,
    hint: '*.example.com covers subdomains of it, not the bare domain.',
  },
  {
    id: 'mcp',
    label: 'An MCP server or tool',
    tool: 'mcp__server',
    placeholder: '',
    build: (tool: string) => tool,
    hint: 'mcp__server covers everything it exposes; mcp__server__tool is one of them.',
  },
  {
    id: 'agent',
    label: 'A subagent type',
    tool: 'Agent',
    placeholder: 'Explore',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: 'The agent type as it is dispatched.',
  },
  {
    id: 'cd',
    label: 'A directory',
    tool: 'Cd',
    placeholder: '~/code/**',
    build: (tool: string, value: string) => `${tool}(${value})`,
    hint: '~/code/* is one segment deep; ~/code/** is any depth.',
  },
  {
    id: 'free',
    label: 'Write it myself',
    tool: '',
    placeholder: 'Bash(task deploy:*)',
    build: (_tool: string, value: string) => value,
    hint: 'Anything the syntax accepts. Checked before it is written.',
  },
] as const;

const LIST_COPY: Record<keyof PolicyLists, { title: string; detail: string }> = {
  deny: {
    title: 'Denied — the wall.',
    detail:
      'Evaluated inside the CLI, with no network involved. Verified to hold with this console ' +
      'stopped. Nothing can approve past it at run time — and removing a rule here is the one edit ' +
      'that widens what every future run may do, so it asks you to confirm.',
  },
  ask: {
    title: 'Asked — the workflow.',
    detail:
      'These raise a card and wait for you. They go through the HTTP hook, and that hook FAILS ' +
      'OPEN: if this console is not running, the call proceeds unasked. Useful, and never the thing ' +
      'to rely on for anything that must not happen.',
  },
  allow: {
    title: 'Allowed.',
    detail:
      'Never round-trip to the hook. The shipped ones are read-only work a phase does constantly; ' +
      'the ones you add also outrank the ask list, which is what makes “Always allow this” on a card ' +
      'actually stop the asking.',
  },
};

const FALLBACK_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Agent',
  'Cd',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

export function PolicyCard({ allowWrites }: { allowWrites: boolean }) {
  const client = useQueryClient();
  const [scope, setScope] = useState<'global' | 'plan'>('global');
  const [slug, setSlug] = useState('');
  const [formId, setFormId] = useState<string>(FORMS[0].id);
  const [tool, setTool] = useState<string>(FORMS[0].tool);
  const [value, setValue] = useState('');
  const [list, setList] = useState<keyof PolicyLists>('ask');
  const [showTraps, setShowTraps] = useState(false);
  // A shipped deny rule about to be struck — held here while the one confirm
  // this page ever raises is open. Ask/allow strikes and your own rules stay
  // one-tap; the wall is the single edit wide enough to earn a second look.
  const [confirmStrike, setConfirmStrike] = useState<string | null>(null);

  const { data: policy } = usePolicy(slug || undefined);
  const { data: plans } = usePlans();

  const form = FORMS.find((f) => f.id === formId) ?? FORMS[0];
  const rule = form.build(tool.trim(), value.trim()).trim();
  const planScope = scope === 'plan';
  const targetKnown = !planScope || Boolean(slug);

  const edit = useMutation({
    mutationFn: (patch: {
      add?: Partial<PolicyLists>;
      remove?: Partial<PolicyLists>;
      reset?: (keyof PolicyLists)[];
      restore?: { deny?: string[]; ask?: string[]; allow?: string[] };
    }) => api.editPolicy({ scope, slug: slug || null, ...patch }),
    onSuccess: (next, patch) => {
      client.setQueryData(keys.policy(slug || ''), next);
      void client.invalidateQueries({ queryKey: ['policy'] });
      const added = patch.add && Object.entries(patch.add)[0];
      toast(
        patch.reset?.length
          ? `Restored ${patch.reset.join(', ')} to the shipped defaults${planScope ? ` for ${slug}` : ''}`
          : added
            ? `Added ${added[1]?.[0]} to ${added[0]}${planScope ? ` for ${slug}` : ''}`
            : 'Removed',
        'ok',
      );
    },
    onError: (error: Error) => toast(String(error.message ?? error), 'error'),
  });

  const toolOptions = useMemo(
    () => [...new Set([...(policy?.hookTools ?? []), ...(policy?.seen ?? []), ...FALLBACK_TOOLS])],
    [policy?.hookTools, policy?.seen],
  );

  // A console whose server predates the policy endpoint has nothing to show,
  // and a card that renders empty controls over no data is worse than absent.
  if (!policy) return null;

  // The rules the CURRENT scope's file holds — removable by dropping the line.
  const mine = (name: keyof PolicyLists): string[] =>
    planScope ? (policy.plan?.extra?.[name] ?? []) : (policy.extra[name] ?? []);

  // Shipped defaults this scope has struck by name — all three lists alike.
  // They vanish from the effective list, so they render below the chips with a
  // way back (↩, or the whole part via Restore defaults).
  const struck = (name: keyof PolicyLists): string[] => {
    const extras = planScope ? policy.plan?.extra : policy.extra;
    return extras?.removed?.[name] ?? [];
  };

  const busy = edit.isPending;

  const add = () => {
    if (!rule || !targetKnown) return;
    edit.mutate({ add: { [list]: [rule] } });
    setValue('');
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>What an unattended session may do</CardTitle>
        <span className="text-2xs text-ink-faint">
          yours are highlighted · <code>{planScope && policy.plan ? policy.plan.path : policy.file}</code>
        </span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-2xs tracking-wide text-ink-faint uppercase">These rules apply</span>
            <select
              value={scope}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value as 'global' | 'plan';
                setScope(next);
                if (next === 'global') setSlug('');
              }}
              className="min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-sm text-ink"
            >
              <option value="global">everywhere</option>
              <option value="plan">to one plan only</option>
            </select>
          </label>
          {planScope && (
            <label className="flex flex-col gap-1">
              <span className="text-2xs tracking-wide text-ink-faint uppercase">Plan</span>
              <select
                value={slug}
                disabled={busy}
                onChange={(event) => setSlug(event.target.value)}
                className="min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-sm text-ink"
              >
                <option value="">choose a plan…</option>
                {(plans ?? []).map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.slug}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {planScope && slug && (
          <p className="text-2xs text-ink-faint">
            Showing the global rules plus <code>{slug}</code>&rsquo;s own. Highlighted chips are the
            plan&rsquo;s; global ones are edited by switching the scope above.
          </p>
        )}

        {(['deny', 'ask', 'allow'] as const).map((name) => (
          <section key={name}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <strong className="text-sm text-ink">{LIST_COPY[name].title}</strong>
              <span className="min-w-0 flex-1 text-2xs text-ink-faint">{LIST_COPY[name].detail}</span>
              {allowWrites && targetKnown && (mine(name).length > 0 || struck(name).length > 0) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  title={`Removes your rules and brings back any shipped defaults you struck, at ${planScope ? `the ${slug} scope` : 'the global scope'}.`}
                  onClick={() => edit.mutate({ reset: [name] })}
                >
                  Restore defaults
                </Button>
              )}
            </div>
            <RuleChips
              rules={policy.effective[name]}
              own={mine(name)}
              defaults={policy.defaults[name]}
              isDeny={name === 'deny'}
              removable={allowWrites && targetKnown}
              busy={busy}
              scopeLabel={planScope ? `the ${slug} scope` : 'the global scope'}
              // One gesture everywhere — except that striking a SHIPPED deny
              // rule is the single edit wide enough to confirm first. Your own
              // deny rules, and every ask/allow removal, stay one tap.
              onRemove={(r) => {
                if (name === 'deny' && policy.defaults.deny.includes(r) && !mine('deny').includes(r)) {
                  setConfirmStrike(r);
                  return;
                }
                edit.mutate({ remove: { [name]: [r] } });
              }}
            />
            {struck(name).length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <span className="text-2xs text-ink-faint">
                  Shipped defaults removed at {planScope ? `the ${slug} scope` : 'the global scope'}:
                </span>
                {struck(name).map((r) => (
                  <span
                    key={r}
                    className="inline-flex items-center gap-1 rounded-sm border border-rule border-dashed px-1.5 py-0.5 font-mono text-2xs text-ink-faint line-through"
                  >
                    {r}
                    {allowWrites && (
                      <button
                        type="button"
                        aria-label={`Restore ${r}`}
                        title="Bring this shipped default back"
                        disabled={busy}
                        onClick={() => edit.mutate({ restore: { [name]: [r] } })}
                        className="text-ink-faint no-underline hover:text-ink disabled:opacity-50"
                      >
                        ↩
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
          </section>
        ))}

        {/* The one confirm this page raises: a shipped deny strike is the
            single edit that widens what every future run may do — on every
            profile, with this console dead — so it is named before it lands. */}
        <AlertDialog
          open={confirmStrike != null}
          onOpenChange={(open) => {
            if (!open) setConfirmStrike(null);
          }}
        >
          <AlertDialogContent
            title="Remove a shipped deny rule?"
            confirmLabel="Remove it"
            cancelLabel="Keep the wall"
            destructive
            onConfirm={() => {
              const struck = confirmStrike;
              setConfirmStrike(null);
              if (struck) edit.mutate({ remove: { deny: [struck] } });
            }}
          >
            <p className="mt-2 text-sm text-ink-muted">
              <code className="rounded bg-surface-raised px-1 font-mono">{confirmStrike}</code> is part of the
              shipped deny list — the layer enforced inside the CLI, which holds even with this console
              stopped. Removed at{' '}
              {planScope ? (
                <>
                  the <code className="font-mono">{slug}</code> scope
                </>
              ) : (
                'the global scope'
              )}
              , every future run — on every profile — may then do it without asking.
            </p>
            <p className="mt-2 text-2xs text-ink-faint">
              Reversible from this screen: the struck rule stays listed with ↩, and Restore defaults brings
              the whole wall back. The edit is written with your name on it and journaled.
            </p>
          </AlertDialogContent>
        </AlertDialog>

        {policy.inert?.length ? (
          <Banner severity="warn">
            <strong>These parse and do nothing.</strong>
            <ul className="mt-1.5 list-disc pl-5">
              {policy.inert.map((r) => (
                <li key={r.raw}>
                  <code>{r.raw}</code> — {r.note}
                </li>
              ))}
            </ul>
          </Banner>
        ) : null}

        {allowWrites ? (
          <div className="flex flex-col gap-2">
            <strong className="text-sm text-ink">Add a rule</strong>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-2xs tracking-wide text-ink-faint uppercase">Form</span>
                <select
                  value={formId}
                  disabled={busy}
                  onChange={(event) => {
                    const next = FORMS.find((f) => f.id === event.target.value) ?? FORMS[0];
                    setFormId(next.id);
                    setTool(next.tool);
                    setValue('');
                  }}
                  className="min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-sm text-ink"
                >
                  {FORMS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>

              {form.id !== 'free' && (
                <label className="flex flex-col gap-1">
                  <span className="text-2xs tracking-wide text-ink-faint uppercase">Tool</span>
                  <input
                    value={tool}
                    disabled={busy}
                    spellCheck={false}
                    list="policy-tools"
                    onChange={(event) => setTool(event.target.value)}
                    className="min-h-(--tap-min) rounded border border-rule bg-ground px-2 font-mono text-sm text-ink"
                  />
                </label>
              )}

              {form.placeholder && (
                <label className="flex min-w-48 flex-1 flex-col gap-1">
                  <span className="text-2xs tracking-wide text-ink-faint uppercase">
                    {form.id === 'free' ? 'Rule' : 'Value'}
                  </span>
                  <input
                    value={value}
                    placeholder={form.placeholder}
                    disabled={busy}
                    spellCheck={false}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        add();
                      }
                    }}
                    className="min-h-(--tap-min) w-full rounded border border-rule bg-ground px-2 font-mono text-sm text-ink"
                  />
                </label>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-2xs tracking-wide text-ink-faint uppercase">to</span>
                <select
                  value={list}
                  disabled={busy}
                  onChange={(event) => setList(event.target.value as keyof PolicyLists)}
                  className="min-h-(--tap-min) rounded border border-rule bg-ground px-2 text-sm text-ink"
                >
                  <option value="deny">deny — never, whatever I click</option>
                  <option value="ask">ask — stop and show me</option>
                  <option value="allow">allow — stop asking about it</option>
                </select>
              </label>
            </div>

            <datalist id="policy-tools">
              {toolOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>

            <p className="text-2xs text-ink-faint">{form.hint}</p>

            {policy.seen?.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-2xs text-ink-faint">Tools this console has been asked about:</span>
                {policy.seen.map((t) => (
                  <Button key={t} size="sm" disabled={busy} onClick={() => setTool(t)}>
                    {t}
                  </Button>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded border border-rule bg-ground px-2 py-1 font-mono text-sm text-ink">
                {rule || '—'}
              </code>
              <Button disabled={busy || !rule || !targetKnown} onClick={add}>
                {busy ? 'Writing…' : planScope ? `Add for ${slug || 'a plan'}` : 'Add everywhere'}
              </Button>
              {!targetKnown && <span className="text-2xs text-ink-faint">Choose a plan first.</span>}
            </div>

            <Banner severity={list === 'allow' ? 'warn' : 'info'}>
              {list === 'allow' ? (
                <span>
                  <strong>This widens what an unattended run may do.</strong> It is written with your name on
                  it, recorded in the live run&rsquo;s journal, and removable with the × on its chip.{' '}
                  <code>deny</code> still refuses it whatever this says.
                </span>
              ) : (
                <span>
                  Adding to <code>deny</code> or <code>ask</code> makes a run more careful. Every rule is
                  removable with the × on its chip — shipped defaults are struck by name and{' '}
                  <em>Restore defaults</em> brings them back. Removing a shipped <code>deny</code> rule is the
                  widest edit this page can make (the wall moves for every future run, with this console dead
                  included), so that one asks you to confirm first.
                </span>
              )}
            </Banner>

            <div>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showTraps}
                onClick={() => setShowTraps(!showTraps)}
              >
                {showTraps ? '▾' : '▸'} How these are evaluated (the parts that surprise people)
              </Button>
              {showTraps && (
                <ul className="mt-1 list-disc pl-5 text-2xs text-ink-muted">
                  <li>
                    <b>deny → allow-you-wrote → ask → allow.</b> First match wins and specificity is
                    irrelevant — a more specific rule does not beat an earlier one.
                  </li>
                  <li>
                    Wrappers are seen through:{' '}
                    <code>timeout time nice nohup stdbuf command builtin noglob</code> and bare{' '}
                    <code>xargs</code>. <b>Not</b>{' '}
                    {(policy.wrappersNotStripped ?? []).map((w) => (
                      <code key={w}> {w}</code>
                    ))}{' '}
                    — a rule about what those run will not fire.
                  </li>
                  <li>
                    <code>watch</code>, <code>setsid</code>, <code>flock</code> and <code>find -exec</code>{' '}
                    never auto-approve: what they actually run cannot be seen from the outside, so they get a
                    card.
                  </li>
                  <li>
                    Only <code>Read(…)</code> and <code>Edit(…)</code> path rules are consulted.{' '}
                    <code>Write(…)</code>, <code>NotebookEdit(…)</code> and <code>Glob(…)</code> paths are
                    ignored.
                  </li>
                  <li>
                    <code>Bash(command:rm *)</code> looks like a parameter rule and is dropped.
                  </li>
                  <li>
                    Only{' '}
                    {(policy.hookTools ?? []).map((t) => (
                      <code key={t}>{t} </code>
                    ))}{' '}
                    reach this console&rsquo;s hook. Rules about anything else are real, but the CLI enforces
                    them and nothing here can show you them being hit.
                  </li>
                </ul>
              )}
            </div>
          </div>
        ) : (
          <p className="text-2xs text-ink-faint">
            Restart with <code>--allow-writes</code> to edit rules here, or edit <code>{policy.file}</code>{' '}
            directly.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function RuleChips({
  rules,
  own,
  defaults,
  isDeny,
  removable,
  busy,
  scopeLabel,
  onRemove,
}: {
  rules: string[];
  own: string[];
  /** The shipped list, so a chip can say which kind it is. */
  defaults: string[];
  /** True on the deny list — a shipped chip's title says the × will confirm. */
  isDeny: boolean;
  removable: boolean;
  busy: boolean;
  scopeLabel: string;
  onRemove: (rule: string) => void;
}) {
  if (!rules.length) return <div className="mt-2 text-2xs text-ink-faint">none</div>;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {rules.map((r) => {
        const isOwn = own.includes(r);
        const isDefault = defaults.includes(r);
        // Yours are always removable; shipped defaults are struck by name
        // (reversible below and via Restore defaults) — deny included, behind
        // the one confirm on this page.
        const canRemove = removable && (isOwn || isDefault);
        const title = isOwn
          ? `yours, at ${scopeLabel}`
          : isDeny
            ? 'shipped deny rule — the wall at run time. × asks to confirm, then removes it for every future run; Restore defaults brings it back.'
            : 'shipped default — × removes it here; Restore defaults brings it back';
        return (
          <span
            key={r}
            title={title}
            className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-2xs
              ${isOwn ? 'border-action/50 bg-action/10 text-ink' : 'border-rule text-ink-muted'}`}
          >
            {r}
            {canRemove && (
              <button
                type="button"
                aria-label={`Remove ${r}`}
                disabled={busy}
                onClick={() => onRemove(r)}
                className="text-ink-faint hover:text-blocked disabled:opacity-50"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The Permissions section — the card in its own frame.
 *
 * Its own export rather than a wrapper in `index.tsx` so that the lazy import
 * pulls the rule editor and this heading together; a section whose title lived
 * in the eagerly-loaded chunk and whose body did not would paint a bare heading
 * for as long as the chunk took.
 */
export function PermissionsSection() {
  const { data: state } = useConsoleState();
  return (
    <SettingsSectionFrame section={sectionFor('permissions')!}>
      <PolicyCard allowWrites={Boolean(state?.allowWrites)} />
    </SettingsSectionFrame>
  );
}
