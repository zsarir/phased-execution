/**
 * Small markdown structure helpers shared by the plan and handoff parsers.
 * These split documents into addressable pieces; rendering happens in the
 * browser.
 */

export type Section = {
  /** Heading text with the `##` markers and surrounding whitespace removed. */
  title: string;
  level: number;
  /** Everything under the heading, up to the next heading of the same or higher level. */
  body: string;
  /** 0-based line index of the heading itself. */
  line: number;
};

/** Split on ATX headings of `level` (default 2 → `## `). */
export function sections(text: string, level = 2): Section[] {
  const marker = '#'.repeat(level);
  const lines = text.split('\n');
  const out: Section[] = [];
  let current: Section | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current) { current.body = buffer.join('\n').trim(); out.push(current); }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading && heading[1].length <= level) {
      if (heading[1] === marker) { flush(); current = { title: heading[2].trim(), level, body: '', line: i }; }
      else { flush(); current = null; }
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return out;
}

/** First section whose title starts with `prefix` (case-insensitive). */
export function findSection(list: Section[], prefix: string): Section | undefined {
  const want = prefix.toLowerCase();
  return list.find((s) => s.title.toLowerCase().startsWith(want));
}

export type Bullet = {
  /** Bold label without the trailing colon, e.g. `Exit criteria`. */
  label: string;
  /** Markdown that followed the label, including any continuation lines. */
  body: string;
};

/**
 * Read `- **Label:** body` bullets out of a block, keeping continuation lines
 * (indented text, nested lists, numbered exit criteria) with their label.
 */
export function labelledBullets(block: string): Bullet[] {
  const lines = block.split('\n');
  const out: Bullet[] = [];
  let current: Bullet | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const start = inFence ? null : /^\s{0,3}[-*]\s+\*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(line);
    if (start) {
      if (current) out.push(current);
      current = { label: start[1].trim().replace(/:$/, ''), body: start[2].trim() };
      continue;
    }
    if (!current) continue;

    // A new top-level bullet without a bold label closes the current field.
    if (!inFence && /^\s{0,3}[-*]\s+/.test(line) && !/^\s{4,}/.test(line)) {
      out.push(current);
      current = null;
      continue;
    }
    current.body += (current.body ? '\n' : '') + line.replace(/^\s{0,2}/, '');
  }
  if (current) out.push(current);
  return out.map((b) => ({ ...b, body: b.body.trim() }));
}

/** Look up a bullet by label prefix (case-insensitive), first match wins. */
export function bullet(list: Bullet[], ...prefixes: string[]): string | undefined {
  for (const prefix of prefixes) {
    const want = prefix.toLowerCase();
    const hit = list.find((b) => b.label.toLowerCase().startsWith(want));
    if (hit) return hit.body;
  }
  return undefined;
}

export type Fence = { lang: string; code: string; line: number };

/** Every fenced code block in `text`, in order. */
export function fences(text: string): Fence[] {
  const lines = text.split('\n');
  const out: Fence[] = [];
  let open: { lang: string; line: number; buf: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(```|~~~)(.*)$/.exec(lines[i]);
    if (m) {
      if (open) { out.push({ lang: open.lang, code: open.buf.join('\n'), line: open.line }); open = null; }
      else open = { lang: m[2].trim(), line: i, buf: [] };
      continue;
    }
    if (open) open.buf.push(lines[i]);
  }
  if (open) out.push({ lang: open.lang, code: open.buf.join('\n'), line: open.line });
  return out;
}

export type TableRow = { cells: string[]; line: number };

/**
 * Pipe-table rows that appear after `heading`, stopping at the first
 * non-table line — the same scoping the engine uses so other tables in the
 * document can never be mistaken for the one we want.
 */
export function tableAfter(text: string, headingTest: (title: string) => boolean): TableRow[] {
  const lines = text.split('\n');
  const rows: TableRow[] = [];
  let scanning = false;
  let seen = false;

  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (heading) {
      if (headingTest(heading[2].trim())) { scanning = true; seen = false; continue; }
      if (scanning && seen) break;
      if (scanning) scanning = false;
      continue;
    }
    if (!scanning) continue;

    if (/^\s*\|/.test(lines[i])) {
      seen = true;
      const cells = lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      rows.push({ cells, line: i });
    } else if (seen) {
      break;
    }
  }
  return rows;
}

/** Drop markdown emphasis/code markers from a table cell. */
export function plainCell(cell: string): string {
  return cell.replace(/[*`]/g, '').trim();
}
