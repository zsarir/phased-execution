/**
 * Which skills a run's sessions should invoke.
 *
 * The plan can already name skills every session must use, and those stay where
 * they are — shown here as fixed, because they are the plan's statement and not
 * this dialog's to change. What this adds is everything for one run: a list of
 * what is actually installed, what each one is for, and a way to turn one on
 * without editing a versioned file.
 *
 * ## Why it is shaped like this
 *
 * There are a few hundred skills on a working machine, which is far past the
 * point where a list is browsable. So the shape follows from that number: it
 * opens closed; the ones you have chosen are pinned to the top where they can
 * be removed without hunting; a source filter cuts the list by an order of
 * magnitude in one click; and search matches the description as well as the
 * name, because "the one that does screenshots" is how people actually look.
 *
 * The list is capped rather than virtualised. A cap is one honest sentence
 * ("117 more — narrow the search"); a virtualiser is a scroll container that
 * lies about its contents to every find-in-page and screen reader that meets it.
 */

import { html, useState, useMemo } from '../html.js';

const SOURCE_LABEL = { project: 'this repo', personal: 'personal', plugin: 'plugins' };
const SOURCE_ORDER = ['project', 'personal', 'plugin'];

/** Past this, the browser is being asked to lay out more than anyone will read. */
const SHOWN_PER_GROUP = 40;

export function SkillPicker({
  skills, chosen, planSkills = [], disabled, onChange, label = 'Skills for this run',
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');

  const picked = new Set(chosen);
  const fromPlan = new Set(planSkills);

  const selectable = useMemo(
    () => skills.filter((s) => !fromPlan.has(s.id)),
    [skills, planSkills.join(',')],
  );

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return selectable.filter((s) => {
      if (source && s.source !== source) return false;
      if (!needle) return true;
      return s.id.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle);
    });
  }, [selectable, query, source]);

  const groups = useMemo(() => {
    const out = new Map();
    for (const skill of matches) {
      if (!out.has(skill.source)) out.set(skill.source, []);
      out.get(skill.source).push(skill);
    }
    return [...out.entries()].sort(
      (a, b) => SOURCE_ORDER.indexOf(a[0]) - SOURCE_ORDER.indexOf(b[0]),
    );
  }, [matches]);

  const available = useMemo(() => {
    const counts = {};
    for (const s of selectable) counts[s.source] = (counts[s.source] ?? 0) + 1;
    return counts;
  }, [selectable]);

  const toggle = (id) => onChange(picked.has(id) ? chosen.filter((s) => s !== id) : [...chosen, id]);

  // A chosen skill that is not installed here still has to be removable, so it
  // is shown from the id alone rather than dropped for want of a description.
  const chosenSkills = chosen.map(
    (id) => skills.find((s) => s.id === id) ?? { id, description: 'not installed on this machine' },
  );

  return html`
    <details class="skill-picker" open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span class="skill-summary-label">${label}</span>
        ${chosen.length ? html`<span class="chip ok">${chosen.length} chosen</span>` : null}
        ${fromPlan.size ? html`<span class="chip">${fromPlan.size} from the plan</span>` : null}
        ${!chosen.length && !fromPlan.size
          ? html`<span class="muted small">none, unless the plan names some</span>` : null}
      </summary>

      ${fromPlan.size ? html`
        <div class="skill-fixed">
          <p class="muted small" style="margin:0 0 6px">
            The plan's <code>Skills (every session)</code> line already puts these in every boot
            prompt. They are not this dialog's to turn off — edit the plan if they are wrong.
          </p>
          <div class="row wrap" style="gap:6px">
            ${[...fromPlan].map((id) => html`<span key=${id} class="chip">${id}</span>`)}
          </div>
        </div>` : null}

      ${chosenSkills.length ? html`
        <div class="skill-chosen" role="group" aria-label="Chosen skills">
          ${chosenSkills.map((s) => html`
            <button key=${s.id} type="button" class="chip is-picked" disabled=${disabled}
                    title=${`${s.description} — click to remove`}
                    aria-label=${`Remove ${s.id}`}
                    onClick=${() => toggle(s.id)}>
              ${s.id}<span aria-hidden="true"> ×</span>
            </button>`)}
        </div>` : null}

      <div class="skill-controls">
        <input
          class="skill-search"
          type="search"
          aria-label="Search skills by name or purpose"
          placeholder=${`Search ${selectable.length} skills — name or what it is for`}
          value=${query}
          disabled=${disabled}
          onInput=${(e) => setQuery(e.target.value)} />
        <div class="row wrap skill-filters" role="group" aria-label="Filter by source">
          <button type="button" class="chip filter" aria-pressed=${String(source === '')}
                  disabled=${disabled} onClick=${() => setSource('')}>
            all ${selectable.length}
          </button>
          ${SOURCE_ORDER.filter((s) => available[s]).map((s) => html`
            <button key=${s} type="button" class="chip filter" aria-pressed=${String(source === s)}
                    disabled=${disabled} onClick=${() => setSource(source === s ? '' : s)}>
              ${SOURCE_LABEL[s]} ${available[s]}
            </button>`)}
        </div>
      </div>

      <div class="skill-list">
        ${groups.length ? groups.map(([group, list]) => html`
          <div key=${group}>
            <div class="skill-group">${SOURCE_LABEL[group] ?? group} · ${list.length}</div>
            ${list.slice(0, SHOWN_PER_GROUP).map((skill) => html`
              <label key=${skill.id} class="skill-row">
                <input type="checkbox" checked=${picked.has(skill.id)} disabled=${disabled}
                       onChange=${() => toggle(skill.id)} />
                <span class="skill-id">${skill.id}</span>
                <span class="skill-what" title=${skill.description}>
                  ${skill.description || 'no description'}
                </span>
              </label>`)}
            ${list.length > SHOWN_PER_GROUP ? html`
              <p class="muted small skill-more">
                ${list.length - SHOWN_PER_GROUP} more in ${SOURCE_LABEL[group] ?? group} — narrow the search to reach them
              </p>` : null}
          </div>`) : html`
          <p class="muted small skill-empty">
            Nothing matches ${query ? html`“<b>${query}</b>”` : 'that filter'}.
            ${source ? html` Try <button type="button" class="linkish" onClick=${() => setSource('')}>all sources</button>.` : null}
          </p>`}
      </div>

      <p class="muted small" style="margin:var(--s3) 0 0">
        Chosen skills are named in the boot prompt of every phase in this run, on top of anything the
        plan asks for. Whether a skill then applies is still the session's judgement — naming one
        makes it available and says it is wanted, which is all naming a skill has ever done.
      </p>
    </details>`;
}
