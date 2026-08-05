/**
 * Plan parser — `docs/plans/<slug>.md`.
 *
 * The dependency graph, `Size:` tags, GATED markers and the Session-budget
 * directives are parsed with **exactly** the rules `scripts/phase-graph.sh`
 * uses, because the console draws its route map from this parse while taking
 * every status claim from the engine. `test/engine-parity.test.ts` asserts the
 * two agree across every real plan; if you change a rule here, change it there
 * first and let the test prove it.
 */

import {
  parseFrontMatter, stripFrontMatter, fmString, fmNumber,
  type FrontMatter,
} from './frontmatter.ts';
import {
  sections, findSection, labelledBullets, bullet, tableAfter, plainCell,
  type Section,
} from './markdown.ts';

export type PhaseRow = {
  phase: number;
  title: string;
  dependsOn: number[];
  parallelSafe: string;
  repos: string;
  exitCriteria: string;
};

export type PhaseSize = 'S' | 'M' | 'L';

export type PhaseDetail = {
  phase: number;
  /** Heading title, `### Phase 4 — Payment` → `Payment`. */
  title: string;
  gated: boolean;
  gates?: string;
  gateCheck?: string;
  size: PhaseSize;
  model?: string;
  /** `**Effort:**` — the reasoning level this phase is worth running at. */
  effort?: string;
  goal?: string;
  readFirst?: string;
  files?: string;
  steps?: string;
  exitCriteria?: string;
  verification?: string;
  /**
   * `**Verify in:**` — the directory the verification commands mean, relative
   * to the repository root.
   *
   * Verification runs `bash -c` with the cwd the console was opened on. In a
   * monorepo that is the superproject, so a plan whose phase lives in one
   * submodule had its suite run against the whole tree — and a real plan's
   * `docker compose run … -v "$PWD:/app"` mounted the entire monorepo into the
   * container and hung. The plan already knows which directory it means; until
   * now there was no way for it to say so.
   */
  verifyIn?: string;
  handoffMustRecord?: string;
  /** Every labelled bullet, so nothing in an unusual plan is dropped. */
  bullets: { label: string; body: string }[];
  raw: string;
};

export type SessionBudget = {
  raw: string;
  targetModel?: string;
  budget?: string;
  branch?: string;
  skills: string[];
  /** Literal plan directive, if present: `on` | `off`. */
  qaGate?: 'on' | 'off';
};

export type Plan = {
  slug: string;
  path: string;
  /** True when a `## Phase graph` table parsed — otherwise this is a document. */
  phased: boolean;
  frontMatter: FrontMatter;
  status?: string;
  /** Date the plan was closed (`close-plan.sh`), when its status is terminal. */
  closed?: string;
  /** Operator's reason for closing, one line. */
  closedReason?: string;
  created?: string;
  declaredPhases?: number;
  memoryKey: string;
  title: string;
  provenance?: string;
  sections: Section[];
  context?: string;
  architecture?: string;
  endToEnd?: string;
  sessionBudget: SessionBudget;
  graph: PhaseRow[];
  /** Blocking / Independent callout lines under the graph table. */
  callouts: string[];
  phases: Record<number, PhaseDetail>;
  body: string;
};

/** En/em dashes → ASCII, so range tokens and the `—` no-deps marker both parse. */
function dashNormalise(text: string): string {
  return text.replace(/[–—]/g, '-');
}

/** `1-7 (+8-10)` → `[1..7, 8..10]`; `—` → `[]` (engine rule, verbatim). */
export function parseDependsOn(cell: string): number[] {
  const raw = dashNormalise(cell).replace(/[^0-9-]+/g, ' ');
  const out: number[] = [];
  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = from; i <= to; i++) out.push(i);
      continue;
    }
    if (/^\d+$/.test(token)) out.push(Number(token));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function parseGraph(text: string): PhaseRow[] {
  const rows = tableAfter(dashNormalise(text), (t) => /^phase graph/i.test(t));
  const out: PhaseRow[] = [];
  for (const row of rows) {
    const phase = plainCell(row.cells[0] ?? '');
    if (!/^\d+$/.test(phase)) continue;           // header, separator and prose rows
    out.push({
      phase: Number(phase),
      title: plainCell(row.cells[1] ?? ''),
      dependsOn: parseDependsOn(row.cells[2] ?? ''),
      parallelSafe: plainCell(row.cells[3] ?? ''),
      repos: plainCell(row.cells[4] ?? ''),
      exitCriteria: (row.cells[5] ?? '').trim(),
    });
  }
  return out;
}

/** `### Phase N …` block, ending at the next `### Phase` or any `## ` heading. */
function phaseBlocks(text: string): Map<number, { title: string; raw: string; headingLine: string }> {
  const lines = text.split('\n');
  const out = new Map<number, { title: string; raw: string; headingLine: string }>();
  let current: { phase: number; title: string; heading: string; buf: string[] } | null = null;

  const flush = () => {
    if (current) out.set(current.phase, { title: current.title, raw: current.buf.join('\n').trim(), headingLine: current.heading });
    current = null;
  };

  for (const line of lines) {
    const heading = /^###\s+[Pp]hase\s+(\d+)\s*(?:[—–-]\s*)?(.*)$/.exec(line);
    if (heading) {
      flush();
      // Some plans collapse finished work under one heading — `### Phase 1–5 —
      // DONE`. The engine files that block under the first number; the leftover
      // text is not a title, so fall back to the graph row's.
      const isRange = /^\d+\s*[—–-]/.test(heading[2]);
      current = {
        phase: Number(heading[1]),
        title: isRange ? '' : heading[2].replace(/\*\(GATED\)\*/i, '').trim(),
        heading: line,
        buf: [],
      };
      continue;
    }
    if (/^##\s/.test(line)) { flush(); continue; }
    if (current) current.buf.push(line);
  }
  flush();
  return out;
}

/**
 * Engine rule: uppercase `GATED` on the `### Phase N` heading, or in that
 * phase's graph row. Case-sensitive on purpose — matching loosely also fires on
 * prose like "born-gated", which would freeze a ready phase behind a gate the
 * plan never declared.
 */
function isGated(text: string, phase: number, heading: string): boolean {
  if (new RegExp(`^### Phase ${phase}(?![\\w])`).test(heading) && heading.includes('GATED')) return true;
  const rowRe = new RegExp(`^\\|\\s*${phase}\\s*\\|.*GATED`, 'm');
  return rowRe.test(text);
}

/** Engine rule: first `size` bullet within 8 lines of the phase heading. */
function phaseSize(text: string, phase: number): PhaseSize {
  const lines = text.split('\n');
  const headingRe = new RegExp(`^### Phase ${phase}(?![\\w])`);
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i])) continue;
    for (const line of lines.slice(i, i + 9)) {
      if (!/^\s*[-*].*size/i.test(line)) continue;
      const m = /size[^A-Za-z]*([A-Za-z])/i.exec(line);
      const letter = m?.[1]?.toUpperCase();
      if (letter === 'S' || letter === 'M' || letter === 'L') return letter;
      return 'M';
    }
  }
  return 'M';
}

function firstBulletValue(block: string, pattern: RegExp): string | undefined {
  for (const line of block.split('\n')) {
    if (!/^\s*[-*]/.test(line)) continue;
    const m = pattern.exec(line);
    if (m) return m[1].replace(/[*`]/g, '').trim();
  }
  return undefined;
}

function parseSessionBudget(section?: Section): SessionBudget {
  const raw = section?.body ?? '';
  const flat = raw.replace(/^[\s>]*/gm, '');

  const model = /\*\*Target model:\*\*\s*`?([^`·\n(]+)`?/i.exec(flat)?.[1]?.trim();
  const budget = /\*\*Budget:\*\*\s*([^·\n]+)/i.exec(flat)?.[1]?.trim();
  const branch = /\*\*Branch:\*\*\s*([^·\n]+)/i.exec(flat)?.[1]?.trim();

  const skillsLine = /\*\*Skills \(every session\):\*\*\s*(.+)/i.exec(flat)?.[1] ?? '';
  const skills = [...skillsLine.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());

  let qaGate: 'on' | 'off' | undefined;
  for (const line of raw.split('\n')) {
    const m = /^[\s>]*\*\*QA gate:\*\*\s*(on|off)\s*$/i.exec(line);
    if (m) { qaGate = m[1].toLowerCase() as 'on' | 'off'; break; }
  }

  return { raw, targetModel: model, budget, branch, skills, qaGate };
}

function calloutLines(text: string): string[] {
  const graph = findSection(sections(text), 'Phase graph');
  if (!graph) return [];
  return graph.body
    .split('\n')
    .filter((l) => /^\*\*(Blocking|Independent|Simultaneous|Parallel)/i.test(l.trim()))
    .map((l) => l.trim());
}

export function parsePlan(text: string, slug: string, path: string): Plan {
  const frontMatter = parseFrontMatter(text);
  const body = stripFrontMatter(text, frontMatter);
  const secs = sections(body);
  const graph = parseGraph(body);

  const titleLine = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? slug;
  const provenance = /^>\s?(.+(?:\n>.*)*)/m.exec(body.split(/^##\s/m)[0] ?? '')?.[0]
    ?.split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n').trim();

  const blocks = phaseBlocks(body);
  const phases: Record<number, PhaseDetail> = {};
  for (const [phase, block] of blocks) {
    const bullets = labelledBullets(block.raw);
    phases[phase] = {
      phase,
      title: block.title || graph.find((row) => row.phase === phase)?.title || `Phase ${phase}`,
      gated: isGated(body, phase, block.headingLine),
      gates: bullet(bullets, 'Gates'),
      gateCheck: firstBulletValue(block.raw, /gate-check[^:]*:\s*(.+)$/i),
      size: phaseSize(body, phase),
      model: bullet(bullets, 'Model'),
      effort: bullet(bullets, 'Effort'),
      goal: bullet(bullets, 'Goal'),
      readFirst: bullet(bullets, 'Read first'),
      files: bullet(bullets, 'Files'),
      steps: bullet(bullets, 'Steps'),
      exitCriteria: bullet(bullets, 'Exit criteria'),
      verification: bullet(bullets, 'Verification'),
      // Distinct prefixes: neither `verification` nor `verify in` starts with
      // the other, so `bullet()`'s prefix match cannot confuse them.
      verifyIn: bullet(bullets, 'Verify in'),
      handoffMustRecord: bullet(bullets, 'Handoff must record'),
      bullets,
      raw: block.raw,
    };
  }

  // A graph row without a `### Phase N` block still deserves a detail record.
  for (const row of graph) {
    if (phases[row.phase]) continue;
    phases[row.phase] = {
      phase: row.phase, title: row.title, gated: /GATED/.test(row.exitCriteria) || isGated(body, row.phase, ''),
      size: phaseSize(body, row.phase), bullets: [], raw: '',
    };
  }

  return {
    slug,
    path,
    phased: graph.length > 0,
    frontMatter,
    status: fmString(frontMatter, 'status'),
    closed: fmString(frontMatter, 'closed'),
    closedReason: fmString(frontMatter, 'closed_reason'),
    created: fmString(frontMatter, 'created'),
    declaredPhases: fmNumber(frontMatter, 'phases'),
    memoryKey: fmString(frontMatter, 'memory') ?? `project_${slug}`,
    title: titleLine,
    provenance: provenance || undefined,
    sections: secs,
    context: findSection(secs, 'Context')?.body,
    architecture: findSection(secs, 'Architecture')?.body,
    endToEnd: findSection(secs, 'End-to-end')?.body,
    sessionBudget: parseSessionBudget(findSection(secs, 'Session budget')),
    graph,
    callouts: calloutLines(body),
    phases,
    body,
  };
}
