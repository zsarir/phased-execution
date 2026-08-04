/**
 * QA sessions: the brief a console hands a reviewer who did not build the thing.
 *
 * ## Why this is not just `--qa-prompt`
 *
 * The engine already emits a QA brief (`phase-graph.sh --qa-prompt N`), and it
 * is the specification here — the discipline, the report path and the recording
 * command all come from it, and this module never invents a different method.
 * What the engine cannot know is everything that lives *outside* the plan file:
 * which handoff the phase actually wrote, which commits it landed, which files
 * it named as its own, whether a verdict is already recorded, and whether QA is
 * even switched on for this plan. A cold reviewer that has to discover those by
 * grepping spends its first turns doing what the console already knows.
 *
 * So the brief is the engine's own text plus the facts around it — and the
 * facts are the part marked expendable, because a reviewer can re-derive every
 * one of them from the repository, while the method it must not improvise is
 * what stays when the 16 KB cap bites.
 *
 * ## Why the review is never the session that built the phase
 *
 * The whole value of a QA pass is that it is read by somebody who does not
 * already believe the code works. A resumed session carries the author's
 * context, its own justifications and its own blind spots, so `parseQaRequest`
 * refuses `resume` outright rather than leaving it to a caller to remember.
 *
 * ## Why this file is a leaf
 *
 * Like `recovery.ts`, whose `assemble` it borrows: every fact arrives as an
 * argument, so `agent.ts` can import it without a cycle and the whole brief is
 * unit-testable with no server, no repository and no board.
 *
 * ## Neutrality
 *
 * The committed template holds no machine-, person- or project-specific
 * strings; only the caller's own facts are interpolated at runtime.
 * `test/qa-session.test.ts` holds it to the same scrub patterns as the guide.
 */

import { assemble } from './recovery.ts';

/** A QA brief is a briefing, not a document — and it must fit the agent cap. */
export const MAX_QA_PROMPT_BYTES = 16 * 1024;

/** Same shape a plan slug takes everywhere else in this codebase. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

/** What `qa-record.sh` accepts, and what `test-status.md` can therefore hold. */
export const QA_RESULTS = ['pass', 'fail', 'waived', 'pending'] as const;
export type QaResult = (typeof QA_RESULTS)[number];

/**
 * A verdict that answers the question.
 *
 * `pending` does not, and neither does a row the parser could not read: both
 * mean the review has not landed, which is why the exit check treats them the
 * same as no row at all.
 */
export function isVerdict(value: string | undefined | null): boolean {
  return value === 'pass' || value === 'fail' || value === 'waived';
}

/** What the browser may ask for. Every other fact on `QaFacts` is server-resolved. */
export type QaRequest = {
  slug: string;
  phase: number;
  /** Turn QA on for a plan whose qa-mode is `off`, before minting. */
  activate?: boolean;
};

export type QaRefusal = { ok: false; status: number; error: string };

/** One line of the board, as the engine reports it. Mirrors `recovery.ts`. */
export type BoardLine = { phase: number; state: string; title?: string };

/** A commit the phase landed, as `git log` reports it. */
export type QaCommit = { sha: string; subject?: string; date?: string };

/**
 * Everything a QA brief may use. Resolved by the service (which can read the
 * plan, the handoff, the board and the repository); this module only formats it.
 */
export type QaFacts = QaRequest & {
  /** Where the phased-execution helper scripts live on this machine. */
  scriptsDir: string;
  /** The id the session should invoke — `phased-execution`, or a namespaced install. */
  skillId: string;
  /** The phase's title from the plan graph, when the board knows it. */
  phaseTitle?: string;
  /** The engine's own brief, verbatim — the method this session must follow. */
  engineBrief?: string;
  /** Where the report goes, repo-relative. */
  reportPath: string;
  /** The same path as `qa-record.sh --report` takes it: relative to the handoff folder. */
  reportArg: string;
  /** The phase's handoff, repo-relative, when it wrote one. */
  handoffPath?: string;
  handoffStatus?: string;
  /** `key_files` off the handoff frontmatter — where the phase says its work is. */
  keyFiles?: string[];
  /** Commits that touched the handoff: the phase's landing point in history. */
  commits?: QaCommit[];
  /** §Phase N's own words, which are the bar this review measures against. */
  goal?: string;
  exitCriteria?: string;
  verification?: string;
  /** The whole board, so the reviewer can see what a fail would hold up. */
  board?: BoardLine[];
  /** `off` here means the verdict gates nothing until QA is activated. */
  qaMode?: string;
  /** A verdict already on file — this review is then a RE-review, not a first one. */
  previous?: { result: string; report?: string };
  /** Skills the plan asks every session to invoke. */
  skills?: string[];
};

/* ------------------------------------------------------------------ *
 * Request parsing
 * ------------------------------------------------------------------ */

/**
 * Validate the QA half of a `POST /api/terminal` body.
 *
 * Refusals name the field and say what is allowed; none of them creates a
 * session — the same contract `parseRecoveryRequest` keeps.
 */
export function parseQaRequest(
  body: Record<string, unknown>,
): { ok: true; request: QaRequest } | QaRefusal {
  const bad = (error: string): QaRefusal => ({ ok: false, status: 400, error });

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!slug) return bad('a QA session needs the slug it is reviewing.');
  if (!SLUG_RE.test(slug)) return bad('that slug is not a plan slug.');

  if (body.phase == null || body.phase === '') return bad('a QA session needs the phase it is reviewing.');
  const phase = Number(body.phase);
  if (!Number.isInteger(phase) || phase < 1 || phase > 999) {
    return bad('phase must be a whole number between 1 and 999.');
  }

  // The first guard, and the one this feature exists for: a review inherited
  // from the session that wrote the code is not an independent review. Refused
  // here rather than in the mint path so no future caller can forget it.
  if (typeof body.resume === 'string' && body.resume) {
    return bad('a QA session is a fresh review — it never resumes the session that built the phase.');
  }

  return { ok: true, request: { slug, phase, ...(body.activate === true ? { activate: true } : {}) } };
}

/**
 * What the tab, the `/resume` picker and the sessions list call it.
 *
 * `QA <slug> P<N>` reads as a row on the board — deliberately the same shape as
 * `Recover <slug> P<N>`, so a list of sessions and a list of phases scan
 * together and the two kinds of session are told apart by their first word.
 */
export function qaLabel(request: { slug: string; phase: number }): string {
  const base = `QA ${request.slug} P${request.phase}`;
  return base.length > 60 ? `${base.slice(0, 59)}…` : base;
}

/**
 * The identity a duplicate guard compares.
 *
 * `(slug, phase)`, like recovery's — two reviewers of one phase write the same
 * report path and race each other's `qa-record.sh` row, and the second is never
 * what anyone meant to press. Mirrored on the client, enforced here.
 */
export function qaKey(link: { slug?: string; phase?: number }): string {
  return `${link.slug ?? ''}#${link.phase ?? ''}`;
}

/* ------------------------------------------------------------------ *
 * The brief
 * ------------------------------------------------------------------ */

/**
 * The briefing for one phase's review.
 *
 * Four movements, in the order a reviewer needs them: what you are, what the
 * console already knows, the method (the engine's own brief, verbatim), and how
 * to record the verdict. The evidence blocks in the middle carry `drop` ranks,
 * so a plan with a long §Verification block sheds facts a reviewer can re-read
 * for itself rather than the instruction that says where the report goes.
 */
export function qaPrompt(facts: QaFacts): string {
  return assemble([
    { text: intro(facts) },
    situation(facts),
    criteria(facts),
    { text: method(facts) },
    boardBlock(facts),
    { text: recording(facts) },
  ], MAX_QA_PROMPT_BYTES);
}

/** Who this session is, and the one thing it must not do. */
function intro(facts: QaFacts): string {
  const lines = [
    `Invoke the ${facts.skillId} skill (/${facts.skillId}) and act as an INDEPENDENT QA`,
    `reviewer for phase ${facts.phase} of "${facts.slug}"`
    + `${facts.phaseTitle ? ` — ${facts.phaseTitle}` : ''}.`,
    "You are in the repository this plan belongs to; the skill's helper scripts live at:",
    facts.scriptsDir,
    '',
    'You did NOT build this phase, and that is the point: the session that wrote the code',
    'shares its own blind spots. Establish ground truth yourself, from the plan and the real',
    "diff. Do not trust the handoff's claims — check them. The facts the console supplies",
    'below are a starting point, not evidence; where the repository disagrees, the',
    'repository is right.',
  ];
  if (facts.previous) {
    lines.push(
      '',
      `A verdict is already on file for this phase: ${facts.previous.result.toUpperCase()}`
      + `${facts.previous.report ? ` (${facts.previous.report})` : ''}. This is a RE-review —`,
      'read that report first, then judge the phase as it stands now. Do not record a pass',
      'merely because the earlier failure was answered in words.',
    );
  }
  if (facts.qaMode === 'off') {
    lines.push(
      '',
      'NOTE: QA is currently OFF for this plan, so nothing is gated on your verdict yet.',
      'Recording one turns gating on for the plan from that point onwards.',
    );
  }
  if (facts.skills?.length) {
    lines.push(
      '',
      `The plan asks every session to invoke these skills first: ${facts.skills.join(', ')}.`,
    );
  }
  return lines.join('\n');
}

/** Where the phase's work is, so the review starts at the diff and not at a search. */
function situation(facts: QaFacts): { text: string; drop?: number } {
  const lines = [
    'What the console knows:',
    '',
    `  plan            ${facts.slug}`,
    `  phase           ${facts.phase}${facts.phaseTitle ? ` — ${facts.phaseTitle}` : ''}`,
    ...(facts.handoffPath
      ? [`  handoff         ${facts.handoffPath}${facts.handoffStatus ? ` (${facts.handoffStatus})` : ''}`]
      : ['  handoff         none written — that is itself a finding']),
    `  report goes to  ${facts.reportPath}`,
    ...(facts.qaMode ? [`  qa mode         ${facts.qaMode}`] : []),
  ];

  if (facts.commits?.length) {
    lines.push(
      '',
      'Commits that touched the handoff — the phase landed at or before these:',
      '',
      ...facts.commits.slice(0, 8).map((commit) =>
        `  ${commit.sha}  ${oneLine(commit.subject ?? '', 90)}${commit.date ? `  (${commit.date})` : ''}`),
      '',
      '  Start from `git show <sha>` and widen with `git log` — a phase often lands its code',
      '  in commits that never touched the docs tree.',
    );
  }

  if (facts.keyFiles?.length) {
    lines.push(
      '',
      'The files the handoff names as its own (read every one of them, in full):',
      '',
      ...facts.keyFiles.slice(0, 30).map((file) => `  ${oneLine(file, 140)}`),
    );
  }

  return { text: lines.join('\n'), drop: 20 };
}

/**
 * §Phase N's own words — the bar, quoted rather than summarised.
 *
 * A reviewer that paraphrases the exit criteria reviews the paraphrase. Ranked
 * below the board for dropping because this is the one block whose absence
 * changes what "pass" means.
 */
function criteria(facts: QaFacts): { text: string; drop?: number } {
  const parts: string[] = [];
  if (facts.goal) parts.push("The phase's stated goal:", '', indent(facts.goal.trim()), '');
  if (facts.exitCriteria) {
    parts.push(
      'Its exit criteria — every one must be true, checked against the repository:',
      '', indent(facts.exitCriteria.trim()), '',
    );
  }
  if (facts.verification) {
    parts.push(
      'Its §Verification block — RUN these yourself; a handoff that claims green is not evidence:',
      '', indent(facts.verification.trim()), '',
    );
  }
  return { text: parts.join('\n').trimEnd(), drop: 30 };
}

/**
 * The method, which is the skill's and not this console's.
 *
 * The engine's `--qa-prompt` output is embedded verbatim when it is available:
 * it is the same brief a phase-finish would dispatch, so a console-launched
 * review and a hand-dispatched one follow one discipline rather than two. The
 * fallback names `references/qa-method.md` rather than paraphrasing it, for the
 * same reason.
 */
function method(facts: QaFacts): string {
  const brief = facts.engineBrief?.trim();
  if (brief) {
    return [
      "The method — this is the skill's own QA brief for this phase, and it is what you follow:",
      '',
      indent(brief),
    ].join('\n');
  }
  return [
    'The method:',
    '',
    `1. Read docs/plans/${facts.slug}.md §Phase ${facts.phase} — goal, exit criteria, Verification.`,
    `2. Read the handoff${facts.handoffPath ? ` (${facts.handoffPath})` : ''} and its key_files, then`,
    '   read ALL the code the phase changed COLD: the git diff of its commits, in full.',
    '3. Investigate for gaps, bugs, regressions and security per the skill\'s own discipline —',
    `   ${skillRoot(facts)}/references/qa-method.md. A real review, not just a test run. Run and`,
    '   extend the tests until every exit criterion is covered.',
    `4. Write the report to ${facts.reportPath}, from ${skillRoot(facts)}/assets/report-template.md.`,
    '5. Record the verdict (below), then commit the report together with test-status.md.',
  ].join('\n');
}

/** The board, so the reviewer can see what a `fail` would hold up. */
function boardBlock(facts: QaFacts): { text: string; drop?: number } {
  const board = facts.board ?? [];
  if (!board.length) return { text: '', drop: 10 };
  return {
    text: [
      'The board right now — a fail gates every phase that depends on this one:',
      '',
      ...board.map((row) =>
        `  P${String(row.phase).padEnd(3)} ${row.state.padEnd(12)}${row.title ? ` ${row.title}` : ''}`),
    ].join('\n'),
    drop: 10,
  };
}

/**
 * How to finish. Never dropped.
 *
 * The one instruction this console cannot afford to lose: the verdict is
 * recorded BY THE SESSION, with `qa-record.sh`, and the console reads it back
 * rather than writing it. A review that ends without running that command has
 * not produced a verdict at all, however confident its closing paragraph — so
 * the command is spelled out with the report path already filled in.
 */
function recording(facts: QaFacts): string {
  return [
    'How to finish — YOU record the verdict; the console never writes one for you:',
    '',
    `  bash ${facts.scriptsDir}/qa-record.sh ${facts.slug} ${facts.phase} <pass|fail|waived> \\`,
    `    --report ${facts.reportArg}`,
    '',
    '  · pass   — every exit criterion holds and the Verification block is green.',
    '  · fail   — something is genuinely wrong. A fail is a gate: it holds every dependent',
    "             until the phase is fixed and re-QA'd, which is exactly what it is for.",
    '             Never record a pass you did not verify, and never soften a real failure.',
    '  · waived — the phase is genuinely out of scope for QA, said plainly, with the reason.',
    '',
    `  The report itself goes to ${facts.reportPath}; the template is at`,
    `  ${skillRoot(facts)}/assets/report-template.md.`,
    '  Never hand-edit test-status.md — qa-record.sh is its only writer, and it is idempotent.',
    '',
    '  Commit the report and test-status.md together, with EXPLICIT paths — never git add -A.',
    '  Commit to the branch already checked out; do not create one, and do not push unless the',
    "  plan says to. End the message with the repository's Co-Authored-By: trailer.",
    '',
    'Then report here in a few sentences: the verdict, what you actually ran, and the findings',
    'that mattered. If you could not reach a verdict, say so plainly — the console reports a',
    'session that recorded nothing as exactly that, and an honest "not verified" is worth more',
    'than a pass nobody checked.',
    '',
    'The operator is watching this terminal. If a real judgement call is open — whether a gap is',
    'a defect or a deliberate scope line — ask here rather than deciding it silently.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Small formatters
 * ------------------------------------------------------------------ */

/**
 * The skill root, derived from the scripts directory the caller passed.
 *
 * `scriptsDir` is the only absolute path this module is allowed to emit (a test
 * asserts that), so the references and assets paths are built from it rather
 * than from anything this process knows about its own installation.
 */
function skillRoot(facts: QaFacts): string {
  return facts.scriptsDir.replace(/\/+scripts\/*$/, '');
}

/** Collapse to one line and cap it. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function indent(text: string): string {
  return text.split('\n').map((line) => `  | ${line}`).join('\n');
}
