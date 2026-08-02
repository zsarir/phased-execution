/**
 * Tolerant front-matter reader for plan / handoff / memory markdown.
 *
 * Real files in the wild are messier than the template: values carry trailing
 * `# active | complete | abandoned` legends, statuses go off-roster
 * (`superseded`, `backlog`, `approved`), whole files have no front matter at
 * all, and `key_files:` blocks mix inline and block list syntax. Parsing must
 * never throw — an unreadable field is `undefined`, not an error.
 *
 * Comment stripping mirrors the engine (`sed 's/[[:space:]]*#.*$//'`): a `#`
 * only starts a comment when whitespace precedes it, so `#anchor` inside a
 * value survives.
 */

export type FrontMatterValue = string | string[] | Record<string, string>;

export type FrontMatter = {
  /** Raw text between the `---` fences, without the fences. */
  raw: string;
  /** Line count consumed, including both fences — 0 when there is no block. */
  lines: number;
  values: Record<string, FrontMatterValue>;
};

const EMPTY: FrontMatter = { raw: '', lines: 0, values: {} };

/** Strip a trailing ` # comment`, surrounding quotes and outer whitespace. */
export function scalar(input: string): string {
  let v = input.replace(/\s+#.*$/, '').trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

/** `[a, b, c]` → `['a','b','c']`; tolerates missing brackets and stray quotes. */
export function inlineList(input: string): string[] {
  const inner = scalar(input).replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["'`]|["'`]$/g, '').trim())
    .filter(Boolean);
}

export function parseFrontMatter(text: string): FrontMatter {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return EMPTY;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return EMPTY;

  const body = lines.slice(1, end);
  const values: Record<string, FrontMatterValue> = {};

  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const m = /^([A-Za-z_][\w.-]*)\s*:\s?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2] ?? '';

    if (rest.trim().startsWith('[')) { values[key] = inlineList(rest); continue; }

    if (scalar(rest) !== '') { values[key] = scalar(rest); continue; }

    // Empty value: look ahead for an indented block (list or mapping).
    const items: string[] = [];
    const map: Record<string, string> = {};
    let j = i + 1;
    for (; j < body.length; j++) {
      const next = body[j];
      if (!next.trim()) continue;
      if (!/^\s/.test(next)) break;
      const item = /^\s*-\s+(.*)$/.exec(next);
      if (item) { const v = scalar(item[1]); if (v) items.push(v); continue; }
      const pair = /^\s*([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(next);
      if (pair) { map[pair[1]] = scalar(pair[2]); continue; }
      break;
    }
    if (items.length) { values[key] = items; i = j - 1; continue; }
    if (Object.keys(map).length) { values[key] = map; i = j - 1; continue; }
    values[key] = '';
  }

  return { raw: body.join('\n'), lines: end + 1, values };
}

/* ------------------------------------------------------------------ *
 * Typed accessors — every one of them returns a usable value or
 * undefined, so callers never branch on shape.
 * ------------------------------------------------------------------ */

export function fmString(fm: FrontMatter, key: string): string | undefined {
  const v = fm.values[key];
  if (typeof v === 'string') return v || undefined;
  if (Array.isArray(v)) return v.join(', ') || undefined;
  return undefined;
}

export function fmNumber(fm: FrontMatter, key: string): number | undefined {
  const v = fmString(fm, key);
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function fmList(fm: FrontMatter, key: string): string[] {
  const v = fm.values[key];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) return inlineList(v);
  return [];
}

/** `depends_on: [1, 4]` → `[1, 4]`, dropping anything non-numeric. */
export function fmPhaseList(fm: FrontMatter, key: string): number[] {
  return fmList(fm, key)
    .map((s) => Number.parseInt(s.replace(/[^0-9]/g, ''), 10))
    .filter((n) => Number.isFinite(n));
}

/** The body after the front-matter block. */
export function stripFrontMatter(text: string, fm: FrontMatter): string {
  return fm.lines ? text.split('\n').slice(fm.lines).join('\n') : text;
}
