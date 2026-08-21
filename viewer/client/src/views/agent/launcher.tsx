/**
 * The launch form: every choice that must exist before the pty does.
 *
 * The options are the autopilot's own vocabularies (`views/run/defaults.ts`),
 * so the two surfaces cannot drift apart — and the server re-validates every
 * field against the runner's lists (`server/agent.ts`), so this form is
 * convenience, never the wall. `bypassPermissions` is deliberately not offered
 * here and refused there.
 */

import { useState } from 'react';
import { Play } from 'lucide-react';
import { useAccounts, useSkills } from '@/lib/queries';
import { Button } from '@/components/ui';
import { SkillPicker } from '../run/skill-picker';
import { field } from '@/components/ui/field';
import { DEFAULTS, EFFORTS, EFFORT_NOTE, MODELS } from '../run/defaults';
// The wizard offers the same list and the tab chip reads it back, so it lives
// in its own module — see the note there.
import { MODES } from './modes';

export interface LaunchBody {
  model?: string;
  effort?: string;
  permissionMode?: string;
  prompt?: string;
  skills?: string[];
  resume?: string;
  /** Which registered account the session spends. Absent = the machine login. */
  accountId?: string;
}

export function Launcher({
  root,
  disabled,
  skillsEnabled,
  onLaunch,
}: {
  /** Where the session will run — the open source directory, when there is one. */
  root?: string;
  /** True at the shared session cap; the form stays visible but cannot start. */
  disabled?: boolean;
  /** `/api/skills` needs an open root; without one the picker hides, never 409s. */
  skillsEnabled: boolean;
  onLaunch(body: LaunchBody): void | Promise<void>;
}) {
  const [model, setModel] = useState<string>(DEFAULTS.model);
  const [effort, setEffort] = useState<string>(DEFAULTS.effort);
  const [mode, setMode] = useState('');
  const [accountId, setAccountId] = useState('default');
  const [prompt, setPrompt] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const { data: skills } = useSkills(skillsEnabled);
  const { data: accountsState } = useAccounts();
  const accounts = accountsState?.accounts ?? [];

  async function submit() {
    setBusy(true);
    try {
      await onLaunch({
        model,
        effort,
        permissionMode: mode,
        ...(accountId !== 'default' ? { accountId } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(chosen.length ? { skills: chosen } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
        <div>
          <h2 className="font-display text-xl">New Claude session</h2>
          <p className="mt-1 text-sm text-ink-muted">
            An interactive Claude Code CLI in a terminal
            {root ? (
              <>
                {' '}
                — running in <span className="font-mono">{root}</span>
              </>
            ) : (
              ' — running in your home directory'
            )}
            . You approve its actions in the terminal itself.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">Model</span>
            <select className={field} value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">default — this machine’s</option>
              {MODELS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">Effort</span>
            <select className={field} value={effort} onChange={(event) => setEffort(event.target.value)}>
              {EFFORTS.map((level) => (
                <option key={level} value={level}>
                  {EFFORT_NOTE[level] ?? level}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-2xs uppercase tracking-wide text-ink-faint">Permissions</span>
            <select className={field} value={mode} onChange={(event) => setMode(event.target.value)}>
              {MODES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          {accounts.length > 0 ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Account</span>
              <select
                className={field}
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.map((account) => {
                  const five = account.usage?.buckets.five_hour;
                  const label = account.builtIn
                    ? `machine login${account.email ? ` (${account.email})` : ''}`
                    : (account.name ?? account.email ?? account.id);
                  return (
                    <option key={account.id} value={account.id}>
                      {label}
                      {five ? ` — 5h ${Math.round(five.utilization)}%` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : null}
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-2xs uppercase tracking-wide text-ink-faint">First prompt (optional)</span>
          {/* text-base = 16px — below that iOS zooms the page on focus. */}
          <textarea
            className="min-h-28 rounded border border-rule bg-ground p-2 text-base"
            placeholder="Sent as your first message. Leave empty to just open the session."
            maxLength={16000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        {skillsEnabled ? (
          <SkillPicker
            skills={skills ?? []}
            chosen={chosen}
            onChange={setChosen}
            label="Skills for this session"
          />
        ) : (
          <p className="text-sm text-ink-faint">Open a source directory to pick skills for the session.</p>
        )}

        <div className="flex items-center gap-3">
          <Button variant="action" disabled={disabled || busy} onClick={() => void submit()}>
            <Play size={15} aria-hidden /> Start session
          </Button>
          {disabled && (
            <span className="text-sm text-ink-faint">Session limit reached — close one first.</span>
          )}
        </div>
      </div>
    </div>
  );
}
