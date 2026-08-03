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
import type { PhaseOptions, PhaseView, SkillInfo } from '@/lib/api';

export function PhaseMatrix({
  planPhases,
  overrides,
  runModel,
  runEffort,
  skills,
  disabled,
  onChange,
}: {
  planPhases: PhaseView[];
  overrides: Record<string, PhaseOptions>;
  runModel: string;
  runEffort: string;
  skills: SkillInfo[];
  disabled?: boolean;
  onChange: (next: Record<string, PhaseOptions>) => void;
}) {
  const [skillsFor, setSkillsFor] = useState<number | null>(null);
  if (!planPhases.length) return null;

  const set = (phase: number, key: keyof PhaseOptions, value: string | string[]) => {
    const key2 = String(phase);
    const next: Record<string, PhaseOptions> = { ...overrides, [key2]: { ...(overrides[key2] ?? {}) } };
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
                        <button
                          type="button"
                          disabled={disabled}
                          aria-expanded={skillsFor === p.phase}
                          onClick={() => setSkillsFor(skillsFor === p.phase ? null : p.phase)}
                          className="rounded border border-rule px-1.5 py-0.5 text-2xs disabled:opacity-50"
                        >
                          {own.skills?.length ? `${own.skills.length} extra` : 'add'}
                        </button>
                      </TD>
                    )}
                  </TR>,
                  skillsFor === p.phase ? (
                    <TR key={`${p.phase}-skills`}>
                      <TD colSpan={skills.length ? 5 : 4}>
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
