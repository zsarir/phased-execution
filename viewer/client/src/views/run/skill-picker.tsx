/**
 * Which skills a run's sessions should invoke.
 *
 * The plan can already name skills every session must use, and those stay where
 * they are — shown here as fixed, because they are the plan's statement and not
 * this control's to change. What this adds is everything for one run: a list of
 * what is actually installed, what each is for, and a way to turn one on without
 * editing a versioned file.
 *
 * ## Why it is shaped like this
 *
 * There are a few hundred skills on a working machine, which is well past the
 * point where a list is browsable. The shape follows from that number: it opens
 * closed; the ones you have chosen are pinned to the top where they can be
 * removed without hunting; a source filter cuts the list by an order of magnitude
 * in one click; and search matches the description as well as the name, because
 * "the one that does screenshots" is how people actually look.
 *
 * The list is capped rather than virtualised. A cap is one honest sentence
 * ("117 more — narrow the search"); a virtualiser is a scroll container that lies
 * about its contents to every find-in-page and screen reader that meets it.
 */

import { useMemo, useState } from 'react';
import { Chip } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { SkillInfo } from '@/lib/api';

const SOURCE_LABEL: Record<string, string> = {
  project: 'this repo',
  personal: 'personal',
  plugin: 'plugins',
};
const SOURCE_ORDER = ['project', 'personal', 'plugin'];

/** Past this, the browser is being asked to lay out more than anyone will read. */
const SHOWN_PER_GROUP = 40;

export function SkillPicker({
  skills,
  chosen,
  planSkills = [],
  defaultSkills = [],
  disabled,
  onChange,
  label = 'Skills for this run',
}: {
  skills: SkillInfo[];
  chosen: string[];
  planSkills?: string[];
  /**
   * Skills this console starts every run with. Shown as a badge on whichever
   * are chosen, so a checkbox nobody ticked is explained rather than mysterious
   * — and unticking one is visibly a decision about THIS run.
   */
  defaultSkills?: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');

  const picked = new Set(chosen);
  const byDefault = new Set(defaultSkills);
  const planKey = planSkills.join(',');

  const selectable = useMemo(
    () => skills.filter((s) => !new Set(planKey ? planKey.split(',') : []).has(s.id)),
    [skills, planKey],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return selectable.filter((s) => {
      if (source && s.source !== source) return false;
      if (!needle) return true;
      return s.id.toLowerCase().includes(needle) || (s.description ?? '').toLowerCase().includes(needle);
    });
  }, [selectable, query, source]);

  const groups = useMemo(() => {
    const out = new Map<string, SkillInfo[]>();
    for (const skill of matches) {
      if (!out.has(skill.source)) out.set(skill.source, []);
      out.get(skill.source)!.push(skill);
    }
    return [...out.entries()].sort((a, b) => SOURCE_ORDER.indexOf(a[0]) - SOURCE_ORDER.indexOf(b[0]));
  }, [matches]);

  const available = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of selectable) counts[s.source] = (counts[s.source] ?? 0) + 1;
    return counts;
  }, [selectable]);

  const toggle = (id: string) => onChange(picked.has(id) ? chosen.filter((s) => s !== id) : [...chosen, id]);

  // A chosen skill that is not installed here still has to be removable, so it
  // is shown from the id alone rather than dropped for want of a description.
  const chosenSkills = chosen.map(
    (id) => skills.find((s) => s.id === id) ?? { id, description: 'not installed on this machine' },
  );

  return (
    <details className="rounded-lg border border-rule bg-surface">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span>{label}</span>
        {chosen.length > 0 && <Chip tone="ok">{chosen.length} chosen</Chip>}
        {planSkills.length > 0 && <Chip>{planSkills.length} from the plan</Chip>}
        {!chosen.length && !planSkills.length && (
          <span className="text-2xs text-ink-faint">none, unless the plan names some</span>
        )}
      </summary>

      <div className="border-t border-rule px-3 py-3">
        {planSkills.length > 0 && (
          <div className="mb-3">
            <p className="mb-1.5 max-w-prose text-2xs text-ink-faint">
              The plan's <code className="font-mono">Skills (every session)</code> line already puts these in
              every boot prompt. They are not this control's to turn off — edit the plan if they are wrong.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {planSkills.map((id) => (
                <Chip key={id} mono>
                  {id}
                </Chip>
              ))}
            </div>
          </div>
        )}

        {chosenSkills.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Chosen skills">
            {chosenSkills.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={disabled}
                title={
                  byDefault.has(s.id)
                    ? `${s.description} — on by default for every run on this console; click to remove it from this one`
                    : `${s.description} — click to remove`
                }
                aria-label={`Remove ${s.id}`}
                onClick={() => toggle(s.id)}
                className="inline-flex items-center gap-1 rounded-sm border border-action/50 bg-action/10 px-1.5 py-0.5 font-mono text-2xs text-action disabled:opacity-50"
              >
                {s.id}
                {byDefault.has(s.id) && (
                  <span className="rounded-xs bg-action/20 px-1 text-[0.9em] not-italic">default</span>
                )}
                <span aria-hidden="true">×</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <input
            type="search"
            aria-label="Search skills by name or purpose"
            placeholder={`Search ${selectable.length} skills — name or what it is for`}
            value={query}
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 [@media(hover:none)]:min-h-(--tap-min) w-full rounded border border-rule bg-ground px-2 text-xs disabled:opacity-50"
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by source">
            <FilterChip pressed={source === ''} disabled={disabled} onClick={() => setSource('')}>
              all {selectable.length}
            </FilterChip>
            {SOURCE_ORDER.filter((s) => available[s]).map((s) => (
              <FilterChip
                key={s}
                pressed={source === s}
                disabled={disabled}
                onClick={() => setSource(source === s ? '' : s)}
              >
                {SOURCE_LABEL[s]} {available[s]}
              </FilterChip>
            ))}
          </div>
        </div>

        <div className="mt-2 max-h-72 overflow-y-auto">
          {groups.length ? (
            groups.map(([group, list]) => (
              <div key={group}>
                <div className="sticky top-0 bg-surface py-1 text-2xs tracking-wide text-ink-faint uppercase">
                  {SOURCE_LABEL[group] ?? group} · {list.length}
                </div>
                {list.slice(0, SHOWN_PER_GROUP).map((skill) => (
                  <label
                    key={skill.id}
                    className="flex items-baseline gap-2 py-0.5 text-2xs hover:bg-surface-raised"
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(skill.id)}
                      disabled={disabled}
                      onChange={() => toggle(skill.id)}
                    />
                    <span className="shrink-0 font-mono">{skill.id}</span>
                    {byDefault.has(skill.id) && (
                      <Chip className="shrink-0" title="On by default for every run on this console">
                        default
                      </Chip>
                    )}
                    <span className="min-w-0 truncate text-ink-faint" title={skill.description}>
                      {skill.description || 'no description'}
                    </span>
                  </label>
                ))}
                {list.length > SHOWN_PER_GROUP && (
                  <p className="py-1 text-2xs text-ink-faint">
                    {list.length - SHOWN_PER_GROUP} more in {SOURCE_LABEL[group] ?? group} — narrow the search
                    to reach them
                  </p>
                )}
              </div>
            ))
          ) : (
            <p className="py-2 text-2xs text-ink-faint">
              Nothing matches {query ? <b>“{query}”</b> : 'that filter'}.
              {source && (
                <>
                  {' '}
                  Try{' '}
                  <button type="button" className="underline" onClick={() => setSource('')}>
                    all sources
                  </button>
                  .
                </>
              )}
            </p>
          )}
        </div>

        <p className="mt-3 max-w-prose text-2xs text-ink-faint">
          Chosen skills are named in the boot prompt of every phase in this run, on top of anything the plan
          asks for. Whether a skill then applies is still the session's judgement — naming one makes it
          available and says it is wanted, which is all naming a skill has ever done.
        </p>
      </div>
    </details>
  );
}

function FilterChip({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-sm border px-1.5 py-0.5 text-2xs disabled:opacity-50',
        pressed ? 'border-action/60 bg-action/12 text-action' : 'border-rule text-ink-muted',
      )}
    >
      {children}
    </button>
  );
}
