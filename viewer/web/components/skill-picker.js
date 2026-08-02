/**
 * Which skills a run's sessions should invoke.
 *
 * The plan can already name skills every session must use, and those stay where
 * they are — shown here as fixed, because they are the plan's statement and not
 * this dialog's to change. What this adds is everything for one run: a list of
 * what is actually installed, with what each one is for, and a way to turn one
 * on without editing a versioned file.
 *
 * Two hundred-odd skills is too many to browse, so it opens closed, filters as
 * you type, and shows the chosen ones first — the only ones you are likely to
 * want to see again.
 */

import { html, useState, useMemo } from '../html.js';

const SOURCE_LABEL = { project: 'this repo', personal: 'personal', plugin: 'plugins' };

export function SkillPicker({ skills, chosen, planSkills = [], disabled, onChange, label = 'Skills for this run' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const picked = new Set(chosen);
  const fromPlan = new Set(planSkills);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = skills.filter((s) => !fromPlan.has(s.id));
    if (!needle) return list;
    return list.filter((s) =>
      s.id.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle));
  }, [skills, query, planSkills.join(',')]);

  // Chosen first, then whatever the filter left, grouped by where it came from.
  const groups = useMemo(() => {
    const out = new Map();
    for (const skill of matches) {
      if (!out.has(skill.source)) out.set(skill.source, []);
      out.get(skill.source).push(skill);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches]);

  const toggle = (id) => {
    const next = picked.has(id) ? chosen.filter((s) => s !== id) : [...chosen, id];
    onChange(next);
  };

  const chosenSkills = chosen
    .map((id) => skills.find((s) => s.id === id) ?? { id, description: 'not installed here', source: 'plugin' });

  return html`
    <details class="skill-picker" open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)}>
      <summary>
        ${label}
        ${chosen.length ? html` <span class="chip">${chosen.length} chosen</span>` : null}
        ${fromPlan.size ? html` <span class="chip">${fromPlan.size} from the plan</span>` : null}
        ${!chosen.length && !fromPlan.size
          ? html`<span class="muted small"> — none, unless the plan names some</span>` : null}
      </summary>

      ${fromPlan.size ? html`
        <div class="skill-fixed">
          <p class="muted small">
            The plan's <code>Skills (every session)</code> line already puts these into every boot
            prompt. They are not this dialog's to turn off — edit the plan if they are wrong.
          </p>
          <div class="row wrap" style="gap:6px">
            ${[...fromPlan].map((id) => html`<span key=${id} class="chip">${id}</span>`)}
          </div>
        </div>` : null}

      ${chosenSkills.length ? html`
        <div class="row wrap" style="gap:6px;margin:var(--s3) 0">
          ${chosenSkills.map((s) => html`
            <button key=${s.id} class="chip is-picked" disabled=${disabled}
                    title=${s.description} onClick=${() => toggle(s.id)}>
              ${s.id} ×
            </button>`)}
        </div>` : null}

      <input
        class="skill-search"
        type="search"
        placeholder=${`Search ${skills.length} skills — name or what it is for`}
        value=${query}
        disabled=${disabled}
        onInput=${(e) => setQuery(e.target.value)} />

      <div class="skill-list">
        ${groups.length ? groups.map(([source, list]) => html`
          <div key=${source}>
            <div class="skill-group">${SOURCE_LABEL[source] ?? source} · ${list.length}</div>
            ${list.slice(0, 60).map((skill) => html`
              <label key=${skill.id} class="skill-row">
                <input type="checkbox" checked=${picked.has(skill.id)} disabled=${disabled}
                       onChange=${() => toggle(skill.id)} />
                <span class="skill-id">${skill.id}</span>
                <span class="skill-what">${skill.description || 'no description'}</span>
              </label>`)}
            ${list.length > 60 ? html`
              <div class="muted small" style="padding:4px 0">
                ${list.length - 60} more — narrow the search to see them
              </div>` : null}
          </div>`) : html`
          <p class="muted small">Nothing matches “${query}”.</p>`}
      </div>

      <p class="muted small">
        Chosen skills are named in the boot prompt of every phase in this run, on top of anything
        the plan asks for. Whether a skill then applies is still the session's judgement — this
        makes it available and says it is wanted, which is all naming a skill ever does.
      </p>
    </details>`;
}
