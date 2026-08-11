/**
 * Per-phase model, effort and skills.
 *
 * Three things can decide what a phase runs as, and this table says which did.
 * The plan's own `**Model:**` / `**Effort:**` bullets have been in the format
 * from the beginning and were read by nothing, so a phase that said it wanted
 * Opus quietly ran on whatever the run defaulted to. Here they show as the
 * *inherited* value, and choosing something overrules them for this run only —
 * per field, so setting a model does not discard an effort the plan asked for.
 */

import { useState } from 'react';
import { Chip, TBody, TD, TH, THead, TR, Table, TableWrap } from '@/components/ui';
import { EFFORTS, MODELS, effortAlias, modelAlias } from './defaults';
import { SkillPicker } from './skill-picker';
import { McpPicker } from './mcp-picker';
import type { McpServerView, PhaseOptions, PhaseView, SkillInfo } from '@/lib/api';

export function PhaseMatrix({
  planPhases,
  overrides,
  runModel,
  runEffort,
  skills,
  runSkills = [],
  servers = [],
  runMcp = [],
  disabled,
  onChange,
}: {
  planPhases: PhaseView[];
  overrides: Record<string, PhaseOptions>;
  runModel: string;
  runEffort: string;
  skills: SkillInfo[];
  /** What the run gives every phase — what the Skip box turns off for one. */
  runSkills?: string[];
  /** The registry, so a phase can attach one the run did not. */
  servers?: McpServerView[];
  /** What the RUN attaches — what `skip run's` would drop for this phase. */
  runMcp?: string[];
  disabled?: boolean;
  onChange: (next: Record<string, PhaseOptions>) => void;
}) {
  const [skillsFor, setSkillsFor] = useState<number | null>(null);
  const [mcpFor, setMcpFor] = useState<number | null>(null);
  // Phase, Title, Model, Effort, plus whichever optional columns render.
  const columns = 4 + (skills.length ? 1 : 0) + (servers.length ? 1 : 0);
  if (!planPhases.length) return null;

  const set = (
    phase: number,
    key: keyof PhaseOptions,
    value: string | string[] | boolean,
  ) => {
    const key2 = String(phase);
    const next: Record<string, PhaseOptions> = { ...overrides, [key2]: { ...(overrides[key2] ?? {}) } };
    // `false` clears for the same reason `''` and `[]` do: it is this control's
    // way of saying "no choice here", and a stored `false` would show as an
    // override on a row where nothing was chosen.
    if (value && (!Array.isArray(value) || value.length)) {
      (next[key2] as Record<string, unknown>)[key] = value;
    } else {
      delete (next[key2] as Record<string, unknown>)[key];
    }
    if (!Object.keys(next[key2]).length) delete next[key2];
    onChange(next);
  };

  const count = Object.keys(overrides).length;

  return (
    <details className="rounded-lg border border-rule bg-surface">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span>Per phase</span>
        {count ? (
          <Chip tone="ok">{count} overridden</Chip>
        ) : (
          <span className="text-2xs text-ink-faint">
            every phase inherits the run's model and effort
          </span>
        )}
      </summary>

      <div className="border-t border-rule">
        <TableWrap>
          <Table>
            <THead>
              <TR>
                <TH scope="col">Phase</TH>
                <TH scope="col">Title</TH>
                <TH scope="col">Model</TH>
                <TH scope="col">Effort</TH>
                {skills.length > 0 && <TH scope="col">Skills</TH>}
                {servers.length > 0 && <TH scope="col">MCP</TH>}
              </TR>
            </THead>
            <TBody>
              {planPhases.map((p) => {
                const own = overrides[String(p.phase)] ?? {};
                // What it would run as with nothing chosen here: the plan if the
                // plan says, otherwise the run's own default.
                const planModel = modelAlias(p.model);
                const planEffort = effortAlias(p.effort);
                const inheritModel = planModel ? `${planModel} (plan)` : `${runModel} (run)`;
                const inheritEffort = planEffort
                  ? `${planEffort} (plan)`
                  : `${runEffort || 'default'} (run)`;
                return [
                  <TR key={p.phase} className={p.state === 'done' ? 'text-ink-faint' : undefined}>
                    <TD className="font-mono tabular-nums">{p.phase}</TD>
                    <TD className="text-2xs">
                      {p.title}
                      {p.state === 'done' && <span className="text-ink-faint"> · done</span>}
                    </TD>
                    <TD>
                      <label className="sr-only" htmlFor={`model-${p.phase}`}>
                        Model for phase {p.phase}
                      </label>
                      <select
                        id={`model-${p.phase}`}
                        value={own.model ?? ''}
                        disabled={disabled}
                        onChange={(e) => set(p.phase, 'model', e.target.value)}
                        className="h-7 w-28 rounded border border-rule bg-ground px-1 text-2xs disabled:opacity-50"
                      >
                        <option value="">{inheritModel}</option>
                        {MODELS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </TD>
                    <TD>
                      <label className="sr-only" htmlFor={`effort-${p.phase}`}>
                        Effort for phase {p.phase}
                      </label>
                      <select
                        id={`effort-${p.phase}`}
                        value={own.effort ?? ''}
                        disabled={disabled}
                        onChange={(e) => set(p.phase, 'effort', e.target.value)}
                        className="h-7 w-28 rounded border border-rule bg-ground px-1 text-2xs disabled:opacity-50"
                      >
                        <option value="">{inheritEffort}</option>
                        {EFFORTS.filter(Boolean).map((e) => (
                          <option key={e} value={e}>
                            {e}
                          </option>
                        ))}
                      </select>
                    </TD>
                    {skills.length > 0 && (
                      <TD>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={disabled}
                            aria-expanded={skillsFor === p.phase}
                            onClick={() => setSkillsFor(skillsFor === p.phase ? null : p.phase)}
                            className="rounded border border-rule px-1.5 py-0.5 text-2xs disabled:opacity-50"
                          >
                            {own.skills?.length ? `${own.skills.length} extra` : 'add'}
                          </button>
                          {/* Only where there is something to skip. A checkbox
                              that turns off an empty list is a control that
                              cannot do anything, offered on every row. */}
                          {runSkills.length > 0 && (
                            <label
                              className="flex items-center gap-1 text-2xs text-ink-faint"
                              title={`Run phase ${p.phase} without the run's skills `
                                + `(${runSkills.join(', ')}). Extras chosen here still apply.`}
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(own.skillsOff)}
                                disabled={disabled}
                                onChange={(e) => set(p.phase, 'skillsOff', e.target.checked)}
                              />
                              skip run&rsquo;s
                            </label>
                          )}
                        </div>
                      </TD>
                    )}
                    {servers.length > 0 && (
                      <TD>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={disabled}
                            aria-expanded={mcpFor === p.phase}
                            onClick={() => setMcpFor(mcpFor === p.phase ? null : p.phase)}
                            className="rounded border border-rule px-1.5 py-0.5 text-2xs disabled:opacity-50"
                          >
                            {own.mcpServers?.length ? `${own.mcpServers.length} extra` : 'add'}
                          </button>
                          {runMcp.length > 0 && (
                            <label
                              className="flex items-center gap-1 text-2xs text-ink-faint"
                              title={`Run phase ${p.phase} without the run's MCP servers `
                                + `(${runMcp.join(', ')}). The plan's own still apply, and so do `
                                + 'extras chosen here.'}
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(own.mcpOff)}
                                disabled={disabled}
                                onChange={(e) => set(p.phase, 'mcpOff', e.target.checked)}
                              />
                              skip run&rsquo;s
                            </label>
                          )}
                        </div>
                      </TD>
                    )}
                  </TR>,
                  skillsFor === p.phase ? (
                    <TR key={`${p.phase}-skills`}>
                      <TD colSpan={columns}>
                        <SkillPicker
                          label={`Extra skills for phase ${p.phase} only`}
                          skills={skills}
                          chosen={own.skills ?? []}
                          disabled={disabled}
                          onChange={(next) => set(p.phase, 'skills', next)}
                        />
                      </TD>
                    </TR>
                  ) : null,
                  mcpFor === p.phase ? (
                    <TR key={`${p.phase}-mcp`}>
                      <TD colSpan={columns}>
                        <McpPicker
                          label={`Extra MCP servers for phase ${p.phase} only`}
                          servers={servers}
                          chosen={own.mcpServers ?? []}
                          onChange={(next) => set(p.phase, 'mcpServers', next)}
                        />
                        {/* Inside the expansion rather than as a column: this is
                            the ONE level that can overrule a plan saying
                            `require`, so it belongs where somebody is already
                            thinking about this phase's servers — not as a
                            per-row control easy to change in bulk. */}
                        <label className="mt-1.5 flex flex-wrap items-center gap-2 text-2xs">
                          <span className="text-ink-faint">
                            If one will not connect, in phase {p.phase} only
                          </span>
                          <select
                            value={own.mcpPolicy ?? ''}
                            disabled={disabled}
                            onChange={(e) => set(p.phase, 'mcpPolicy', e.target.value)}
                            className="rounded border border-rule bg-ground px-1.5 py-0.5 text-2xs text-ink"
                          >
                            <option value="">inherit (plan, then run)</option>
                            <option value="continue">run the phase without it</option>
                            <option value="require">park the phase</option>
                          </select>
                        </label>
                      </TD>
                    </TR>
                  ) : null,
                ];
              })}
            </TBody>
          </Table>
        </TableWrap>
        <p className="max-w-prose px-3 py-2 text-2xs text-ink-faint">
          A phase already running keeps what it started with — these apply to phases that have not
          begun. Clearing a row hands it back to the plan, or to the run's own default.
        </p>
      </div>
    </details>
  );
}
