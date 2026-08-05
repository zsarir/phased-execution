/**
 * Recovery sessions: the prompt a console hands an AI when an algorithm cannot
 * finish the job.
 *
 * ## What this module is for
 *
 * Phase 3 gave every "Waiting on you" card a remedy that a rule could compute —
 * a superseded run resolves itself, an expired lock releases without retyping
 * an owner. What is left over is the residue: a phase whose verification went
 * red, a session that ended without writing its handoff, a plan table that
 * disagrees with its own handoffs. None of those has a deterministic fix, and
 * all of them are ordinary work for someone who reads the evidence.
 *
 * So the console composes the brief it would have written by hand: the facts it
 * already holds (which run, which phase, what the board says, what actually
 * failed) plus the exact procedure the phased-execution skill prescribes for
 * that situation. One click, and the session starts already knowing everything
 * a person would have had to paste in.
 *
 * ## Why this file is a leaf
 *
 * `recovery.ts` imports nothing. Every fact reaches it as an argument, which is
 * what lets `agent.ts` import it without a cycle (`agent.ts` → `recovery.ts`,
 * never back) and what lets the prompts be unit-tested with no server, no repo
 * and no board — the same reason `push/catalogue.ts` is a leaf.
 *
 * ## Why the prompts name scripts rather than describing them
 *
 * A recovery session is booted cold. "Write the handoff" is an instruction it
 * can interpret six ways; `bash <scriptsDir>/new-handoff.sh <slug> <N> <title>`
 * is one. Every prompt below spells the invocation, because the failure mode
 * that costs the most is a session that does good work in the wrong shape.
 *
 * ## Neutrality
 *
 * The committed template must stay free of machine-, person- and
 * project-specific strings — only the caller's own facts are interpolated at
 * runtime. `test/recovery-sessions.test.ts` holds this file to the same scrub
 * patterns as the guide.
 */

/** A recovery prompt is a briefing, not a document — and it must fit the agent cap. */
export const MAX_RECOVERY_PROMPT_BYTES = 16 * 1024;

/**
 * The failure classes a recovery session is offered for.
 *
 * These are the *residue* of `runner/errors.ts`'s dispositions and
 * `analysis/stats.ts`'s health issues: what is left once every automatic
 * remedy has been tried. Each one gets its own prompt because each one wants a
 * different first move — diagnose, close out, resume, take over, repair.
 */
export const RECOVERY_CLASSES = [
  /** The phase ran, and its §Verification commands came back red. */
  'halted-verification',
  /** The work looks done but the phase never wrote its handoff. */
  'halted-missing-handoff',
  /** The console or the run died mid-phase; the working tree is where it stopped. */
  'interrupted-resume',
  /** The run halted on authentication. Minting is refused while signed out. */
  'auth-interrupted',
  /** A lease expired: the phase reads as taken and nobody is in it. */
  'stale-claim-takeover',
  /** The plan, its handoffs or its INDEX disagree — including a recorded QA fail. */
  'plan-repair',
] as const;

export type RecoveryClass = (typeof RECOVERY_CLASSES)[number];

export function isRecoveryClass(value: unknown): value is RecoveryClass {
  return typeof value === 'string' && (RECOVERY_CLASSES as readonly string[]).includes(value);
}

/** What the button says, and what the session's notification calls it. */
export const RECOVERY_TITLES: Record<RecoveryClass, string> = {
  'halted-verification': 'Fix the failing verification',
  'halted-missing-handoff': 'Finish the closeout',
  'interrupted-resume': 'Resume where it stopped',
  'auth-interrupted': 'Continue after signing in',
  'stale-claim-takeover': 'Take over the claim',
  'plan-repair': 'Repair the plan',
};

/** What the browser may ask for. Everything else on `RecoveryFacts` is server-resolved. */
export type RecoveryRequest = {
  class: RecoveryClass;
  slug: string;
  phase?: number;
  runId?: string;
};

export type RecoveryRefusal = { ok: false; status: number; error: string };

/** One line of the board, as the engine reports it. */
export type BoardLine = { phase: number; state: string; title?: string };

/** The failing evidence, trimmed to what fits in a briefing. */
export type RecoveryDiagnosis = {
  /** Which check is in the way: the board, the verification commands, or the lint. */
  blockedOn?: 'board' | 'verification' | 'lint' | null;
  /** What the board says about this phase specifically. */
  boardState?: string;
  /** The phase session's closing words. */
  said?: string | null;
  /** Verification commands that ran, with their tails. */
  verification?: {
    ok: boolean;
    reason?: string;
    ran?: { command: string; ok: boolean; code?: number; output?: string }[];
    notRun?: { text: string; reason: string }[];
  } | null;
  lint?: { ok: boolean; summary: string } | null;
  /** `git status --porcelain`, already capped by the caller. */
  workingTree?: string[];
  /** The phase session's claude id, when one can still be resumed. */
  sessionId?: string | null;
  resumable?: boolean;
};

/** A health issue worth repairing, in the shape `analysis/stats.ts` emits. */
export type RecoveryIssue = {
  kind: string;
  message: string;
  phase?: number;
  severity?: string;
};

/**
 * Everything a prompt builder may use. Resolved by the service (which can read
 * the board, the run and the lock); this module only formats it.
 */
export type RecoveryFacts = RecoveryRequest & {
  /** Where the phased-execution helper scripts live on this machine. */
  scriptsDir: string;
  /** The id the session should invoke — `phased-execution`, or a namespaced install. */
  skillId: string;
  /** The phase's title from the plan graph, when the board knows it. */
  phaseTitle?: string;
  /** The run's status word (`halted`, `interrupted`, …). */
  runStatus?: string;
  /** The reason recorded on the halt. */
  haltReason?: string;
  /** The whole board, so the session can see what is done around it. */
  board?: BoardLine[];
  diagnosis?: RecoveryDiagnosis;
  /** Who holds the stale claim, and what its lease said. */
  lockOwner?: string;
  lockDetail?: string;
  /** Who the recovery session should claim as. */
  newOwner?: string;
  /** The issues to repair (`plan-repair`). */
  issues?: RecoveryIssue[];
  /**
   * Set when the run this recovery continues works on a console-declared
   * branch (`gitMode: 'new-branch'`). The discipline block's branch bullet
   * flips on it: a recovery of a branched run must commit to that branch, and
   * the default text — "commit to what is checked out, never checkout -b" —
   * would point it at the wrong tree.
   */
  gitStrategy?: { branch: string };
};

/* ------------------------------------------------------------------ *
 * Request parsing
 * ------------------------------------------------------------------ */

/** Same shape a plan slug takes everywhere else in this codebase. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

/**
 * Validate the recovery half of a `POST /api/terminal` body.
 *
 * Refusals name the field and the allowed values, and none of them creates a
 * session — the same contract `buildAgentLaunch` keeps for every other field.
 */
export function parseRecoveryRequest(
  body: Record<string, unknown>,
): { ok: true; request: RecoveryRequest } | RecoveryRefusal {
  const bad = (error: string): RecoveryRefusal => ({ ok: false, status: 400, error });

  const kind = body.recoveryClass;
  if (!isRecoveryClass(kind)) {
    return bad(`recoveryClass must be one of: ${RECOVERY_CLASSES.join(', ')}.`);
  }

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!slug) return bad('a recovery session needs the slug it is recovering.');
  if (!SLUG_RE.test(slug)) return bad('that slug is not a plan slug.');

  let phase: number | undefined;
  if (body.phase != null && body.phase !== '') {
    const parsed = Number(body.phase);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999) {
      return bad('phase must be a whole number between 1 and 999.');
    }
    phase = parsed;
  }

  const runId = typeof body.runId === 'string' && body.runId ? body.runId.slice(0, 64) : undefined;

  // Every class except plan-repair acts on one phase; a prompt that cannot name
  // the phase is a prompt that tells a session to guess.
  if (phase == null && kind !== 'plan-repair') {
    return bad(`a ${kind} recovery needs the phase it is recovering.`);
  }

  return { ok: true, request: { class: kind, slug, phase, runId } };
}

/**
 * What the tab, the `/resume` picker and the sessions list call it.
 *
 * Deliberately the same shape as the thing it repairs — `Recover <slug> P<N>`
 * reads as a row on the board, so a list of sessions and a list of phases can
 * be scanned together.
 */
export function recoveryLabel(request: RecoveryRequest): string {
  const base = request.phase != null
    ? `Recover ${request.slug} P${request.phase}`
    : `Recover ${request.slug}`;
  return base.length > 60 ? `${base.slice(0, 59)}…` : base;
}

/** The identity a duplicate guard compares. A plan-wide repair has no phase. */
export function recoveryKey(link: { slug?: string; phase?: number }): string {
  return `${link.slug ?? ''}#${link.phase ?? ''}`;
}

/* ------------------------------------------------------------------ *
 * The prompts
 * ------------------------------------------------------------------ */

/**
 * The briefing for one failure class.
 *
 * Every prompt has the same four movements — what happened, what is true now,
 * what to do (as numbered steps naming real commands), and how to finish — so
 * a session that has seen one recognises the next. What changes between
 * classes is the first move, which is the whole reason they are separate.
 */
export function recoveryPrompt(facts: RecoveryFacts): string {
  const blocks = ((): Block[] => {
    switch (facts.class) {
      case 'halted-verification': return haltedVerification(facts);
      case 'halted-missing-handoff': return haltedMissingHandoff(facts);
      case 'interrupted-resume': return interruptedResume(facts);
      case 'auth-interrupted': return authInterrupted(facts);
      case 'stale-claim-takeover': return staleClaimTakeover(facts);
      case 'plan-repair': return planRepair(facts);
    }
  })();
  return assemble(blocks, MAX_RECOVERY_PROMPT_BYTES);
}

function haltedVerification(facts: RecoveryFacts): Block[] {
  const { slug, phase } = facts;
  return [
    keep(intro(facts, 'Mode 2 (phase-start), then Mode 3 (phase-finish)')),
    keep([
      `Phase ${phase} of "${slug}" ran and its verification came back RED. The run is`,
      `${facts.runStatus ?? 'halted'} and will stay that way until the phase verifies green.`,
      '',
      'Your job is to make it pass honestly — never by weakening the check.',
    ].join('\n')),
    situation(facts),
    evidence(facts),
    keep([
      'Do this:',
      '',
      `1. Bootstrap: bash ${facts.scriptsDir}/handoff-status.sh ${slug} — then read`,
      `   docs/plans/${slug}.md §Phase ${phase} (its Verification block is the bar) and the`,
      `   handoffs of the phases it depends on.`,
      `2. DIAGNOSE before you change anything. Reproduce the failing command yourself and`,
      '   find the cause. Do not re-run it hoping for a different answer, and do not delete,',
      '   skip, weaken or comment out a test, an assertion or a check to make it green —',
      '   if the check itself is genuinely wrong, say so explicitly and explain why.',
      '3. Fix the root cause.',
      `4. Re-run EVERY command in §Phase ${phase}'s Verification block. All green is the bar.`,
      `5. If it is green, finish the phase (skill Mode 3): commit, then`,
      `   bash ${facts.scriptsDir}/new-handoff.sh ${slug} ${phase} <title> and fill in the`,
      '   frontmatter and body, then update the memory entry the plan names.',
      '6. If you cannot get it green, hand off BLOCKED instead —',
      `   bash ${facts.scriptsDir}/new-handoff.sh ${slug} ${phase} <title> blocked — recording`,
      '   the exact failure and what you tried. Never write a complete handoff on red',
      '   verification.',
    ].join('\n')),
    keep(discipline(facts)),
  ];
}

function haltedMissingHandoff(facts: RecoveryFacts): Block[] {
  const { slug, phase } = facts;
  return [
    keep(intro(facts, 'Mode 3 (phase-finish)')),
    keep([
      `Phase ${phase} of "${slug}" stopped without a usable handoff — the session ended`,
      'before its closeout, so the work may well be done and the record is missing.',
      '',
      'Assume the work is DONE until the repository tells you otherwise. Your job is the',
      'closeout, not the phase: re-doing finished work is the expensive mistake here.',
    ].join('\n')),
    situation(facts),
    evidence(facts),
    keep([
      'Do this:',
      '',
      `1. Bootstrap: bash ${facts.scriptsDir}/handoff-status.sh ${slug}, then read`,
      `   docs/plans/${slug}.md §Phase ${phase}.`,
      `2. Establish what actually landed: git log for the phase's commits and git status`,
      '   for anything still uncommitted. Check each exit criterion in §Phase',
      `   ${phase} against the repository itself.`,
      `3. Run §Phase ${phase}'s Verification commands. They are the bar for a complete`,
      '   handoff, and you have not seen them pass yet.',
      '4. Commit anything the phase left uncommitted (explicit paths).',
      `5. Write the handoff: bash ${facts.scriptsDir}/new-handoff.sh ${slug} ${phase} <title>`,
      '   — it scaffolds the file, fills depends_on/blocks from the plan graph, updates',
      '   INDEX.md and generates the boot prompts for whatever this phase unblocks. Fill in',
      '   the frontmatter and every section; record the REAL commit shas, verified with',
      '   git log -1, never remembered.',
      '6. Update the memory entry the plan names with the phase status and commits.',
      '7. If an exit criterion is genuinely unmet, do not paper over it: finish that work',
      '   first, or write the handoff as blocked and say which criterion failed.',
    ].join('\n')),
    keep(discipline(facts)),
  ];
}

function interruptedResume(facts: RecoveryFacts): Block[] {
  const { slug, phase } = facts;
  return [
    keep(intro(facts, 'Mode 2 (phase-start)')),
    keep([
      `Phase ${phase} of "${slug}" was interrupted — the run or the console died while the`,
      'phase was in flight. Nothing is driving it now, and the working tree is wherever it',
      'stopped: possibly mid-edit, possibly with uncommitted work worth keeping.',
      '',
      'Assess before you act. The first rule is to lose nothing that was already done.',
    ].join('\n')),
    situation(facts),
    evidence(facts),
    keep([
      'Do this:',
      '',
      '1. Read the working tree FIRST: git status and git diff. Anything uncommitted is',
      '   the interrupted phase\'s work — understand it before you touch it. Never',
      '   git stash, git checkout -- or git reset it away.',
      `2. Bootstrap: bash ${facts.scriptsDir}/handoff-status.sh ${slug}, then`,
      `   docs/plans/${slug}.md §Phase ${phase} + §Session budget, and the dependency`,
      '   handoffs it names.',
      `3. Confirm the board still shows phase ${phase} as startable, then claim it:`,
      `   bash ${facts.scriptsDir}/phase-lock.sh ${slug} claim ${phase} --owner`,
      `   "${facts.newOwner ?? '<your-session-id>'}" --git`,
      '   If it reports another live session holds the lock, STOP and say so — do not force it.',
      `4. Reset the task list and create this phase's tasks, prefixed p${phase}.taskM.`,
      '5. Continue the phase from where it stopped to its exit criteria — completing the',
      '   half-finished work rather than starting it over.',
      `6. Finish it (skill Mode 3): §Phase ${phase}'s Verification commands green, commit,`,
      `   bash ${facts.scriptsDir}/new-handoff.sh ${slug} ${phase} <title>, update memory,`,
      `   then release the lock: bash ${facts.scriptsDir}/phase-lock.sh ${slug} release`,
      `   ${phase} --owner "${facts.newOwner ?? '<your-session-id>'}" --git`,
    ].join('\n')),
    keep(discipline(facts)),
  ];
}

function authInterrupted(facts: RecoveryFacts): Block[] {
  const { slug, phase } = facts;
  return [
    keep(intro(facts, 'Mode 2 (phase-start)')),
    keep([
      `The run of "${slug}" halted on an AUTHENTICATION failure at phase ${phase} — not on`,
      'anything wrong with the work. The console refuses to open this session while the CLI',
      'reports signed out, so by the time you are reading this the credentials are back.',
      '',
      'That means the phase itself is probably intact and simply never got to finish.',
    ].join('\n')),
    situation(facts),
    evidence(facts),
    keep([
      'Do this:',
      '',
      '1. Check the working tree before anything else: git status and git diff. The halt',
      '   was external, so whatever the phase had done is still sitting there.',
      `2. Bootstrap: bash ${facts.scriptsDir}/handoff-status.sh ${slug}, then`,
      `   docs/plans/${slug}.md §Phase ${phase}.`,
      `3. Claim the phase if it is not already yours:`,
      `   bash ${facts.scriptsDir}/phase-lock.sh ${slug} claim ${phase} --owner`,
      `   "${facts.newOwner ?? '<your-session-id>'}" --git`,
      '4. Carry the phase to its exit criteria, then finish it the usual way (Mode 3):',
      '   verification green, commit, handoff, memory, release the lock.',
      '5. If authentication fails AGAIN, stop immediately and say so plainly. Do not retry',
      '   in a loop and do not try to re-authenticate from inside this session — signing in',
      '   needs a terminal and a browser, and it is the operator\'s move, not yours.',
    ].join('\n')),
    keep(discipline(facts)),
  ];
}

function staleClaimTakeover(facts: RecoveryFacts): Block[] {
  const { slug, phase } = facts;
  const owner = facts.newOwner ?? '<your-session-id>';
  return [
    keep(intro(facts, 'Mode 2 (phase-start)')),
    keep([
      `Phase ${phase} of "${slug}" reads as claimed, but the lease has EXPIRED —`,
      `${facts.lockOwner ? `it is held by "${facts.lockOwner}"` : 'the holder is recorded in the lock file'}`,
      'and that session is gone. The phase looks taken and nobody is in it.',
      '',
      'You are taking it over. The claim is stale, so forcing it is correct here — but',
      'check the tree before you assume nothing was done under it.',
    ].join('\n')),
    situation(facts),
    evidence(facts),
    keep([
      'Do this:',
      '',
      `1. Confirm the claim really is dead:`,
      `   bash ${facts.scriptsDir}/phase-lock.sh ${slug} status ${phase}`,
      '   If it reports a LIVE lease, stop — another session is working and this is not a',
      '   takeover, it is a collision.',
      '2. git status / git diff: a session that died mid-phase may have left work behind.',
      '   Keep it.',
      `3. Take the claim:`,
      `   bash ${facts.scriptsDir}/phase-lock.sh ${slug} claim ${phase} --owner "${owner}"`,
      '   --force --git',
      `4. Bootstrap the phase: bash ${facts.scriptsDir}/handoff-status.sh ${slug}, then`,
      `   docs/plans/${slug}.md §Phase ${phase} + §Session budget and the dependency handoffs.`,
      `5. Reset the task list (p${phase}.taskM ids) and carry the phase to its exit criteria.`,
      `6. Finish it (Mode 3): verification green, commit, handoff, memory, then release:`,
      `   bash ${facts.scriptsDir}/phase-lock.sh ${slug} release ${phase} --owner "${owner}" --git`,
    ].join('\n')),
    keep(discipline(facts)),
  ];
}

/**
 * The repair prompt, which is really several: what to fix depends entirely on
 * which health issue is being repaired, and a generic "make validate.sh pass"
 * is exactly the instruction that produces a plan edited until the checker
 * stops complaining.
 */
function planRepair(facts: RecoveryFacts): Block[] {
  const { slug } = facts;
  const issues = facts.issues ?? [];
  const kinds = [...new Set(issues.map((issue) => issue.kind))];
  const qaOnly = kinds.length > 0 && kinds.every((kind) => kind === 'qa-fail');

  const perKind = kinds.map((kind) => `   · ${kind} — ${REPAIR_ADVICE[kind] ?? REPAIR_ADVICE.default}`);

  return [
    keep(intro(facts, qaOnly ? 'its QA method (references/qa-method.md)' : 'Mode 3 (the artefact rules)')),
    keep(
      qaOnly
        ? [
          `A phase of "${slug}" has a recorded QA result of FAIL. That result is a gate: every`,
          'dependent phase stays blocked until it is re-QA\'d, so this is not a bookkeeping',
          'error to overwrite — it is a verdict to answer.',
        ].join('\n')
        : [
          `The plan "${slug}" disagrees with itself. Its plan table, its handoffs and its`,
          'INDEX are the machine-readable inputs the board is computed from, so while they',
          'disagree every status the console reports about this plan is suspect.',
          '',
          'Repair MINIMALLY. Change the artefact that is wrong, never the one that makes the',
          'checker quiet — and never edit a status to something the repository does not support.',
        ].join('\n'),
    ),
    issueBlock(issues),
    boardBlock(facts),
    keep([
      'Do this:',
      '',
      `1. Read the ground truth first: bash ${facts.scriptsDir}/validate.sh ${slug} (it lints`,
      '   the plan AND the handoffs) and',
      `   bash ${facts.scriptsDir}/phase-graph.sh ${slug} --lint`,
      `2. Read docs/plans/${slug}.md's "## Phase graph" table and the handoff frontmatter it`,
      '   disagrees with. Decide which one is actually wrong by checking the repository —',
      '   the commits, the files, what was really done.',
      ...(perKind.length ? ['3. Repair each issue by its kind:', ...perKind] : ['3. Repair each issue named above.']),
      `4. Re-run bash ${facts.scriptsDir}/validate.sh ${slug} until it exits 0.`,
      ...(kinds.includes('qa-fail')
        ? [
          '5. For the recorded QA failure: re-run QA per the skill\'s references/qa-method.md',
          '   — read the phase\'s diff cold, run and extend its tests — then record the real',
          `   verdict with bash ${facts.scriptsDir}/qa-record.sh ${slug} <N> <pass|fail|waived>`,
          '   --report <rel-path> and commit the report with it. Never hand-edit',
          '   test-status.md, and never record a pass you did not verify: if it still fails,',
          '   record fail and say what is broken.',
        ]
        : []),
      `${kinds.includes('qa-fail') ? '6' : '5'}. Commit the repaired artefacts, then report what you`,
      '   changed and why the other side was the wrong one to edit.',
    ].join('\n')),
    keep(discipline(facts)),
  ];
}

/** What "repair" means for each health-issue kind the engine emits. */
const REPAIR_ADVICE: Record<string, string> = {
  'phase-count': "the plan's frontmatter `phases:` count and the rows the graph table actually "
    + 'parses disagree. Usually a malformed row the parser skipped — fix the ROW, not the count.',
  'undefined-dep': 'a phase depends on a phase number that is not in the table. Either the '
    + 'dependency is a typo or the row is missing entirely.',
  'depends-drift': "a handoff's depends_on disagrees with the graph. The plan graph is the "
    + 'source of truth for dependencies; correct the handoff frontmatter to match it.',
  'index-drift': 'a handoff is missing from INDEX.md. Re-running new-handoff.sh for that phase '
    + 'rebuilds the index entry.',
  'stale-handoff': 'a handoff is still in-progress or blocked. Establish what really happened to '
    + 'that phase, finish it if it is finishable, and set the status the repository supports.',
  'missing-handoff': 'a phase counts as done with no handoff file. Verify it really is done, then '
    + 'write the handoff.',
  'qa-fail': 'a recorded QA failure gates every dependent — re-run QA, do not overwrite the row.',
  engine: 'the engine could not read the graph at all. The table is malformed; fix its shape first.',
  default: 'read what the issue says, check the repository, and correct whichever artefact is wrong.',
};

/* ------------------------------------------------------------------ *
 * Shared sections
 * ------------------------------------------------------------------ */

/** The first line of every prompt: which skill, which mode, and where its scripts are. */
function intro(facts: RecoveryFacts, mode: string): string {
  return [
    `Invoke the ${facts.skillId} skill (/${facts.skillId}) and use ${mode} for the`,
    'situation below. You are in the repository this plan belongs to; the skill\'s helper',
    'scripts live at:',
    facts.scriptsDir,
    '',
    'This session was opened by the Phase Console to repair one specific thing. Everything',
    'below is what the console already knows — verify it against the repository rather than',
    'trusting it, and if the repository disagrees, the repository is right.',
  ].join('\n');
}

/** Slug, phase, run — the identifiers every command below needs. */
function situation(facts: RecoveryFacts): Block {
  const lines = [
    'What the console knows:',
    '',
    `  plan            ${facts.slug}`,
    ...(facts.phase != null
      ? [`  phase           ${facts.phase}${facts.phaseTitle ? ` — ${facts.phaseTitle}` : ''}`]
      : []),
    ...(facts.runId ? [`  run id          ${facts.runId}`] : []),
    ...(facts.runStatus ? [`  run status      ${facts.runStatus}`] : []),
    ...(facts.diagnosis?.boardState ? [`  board says      ${facts.diagnosis.boardState}`] : []),
    ...(facts.diagnosis?.blockedOn ? [`  blocked on      ${facts.diagnosis.blockedOn}`] : []),
    ...(facts.lockOwner ? [`  claimed by      ${facts.lockOwner}`] : []),
    ...(facts.lockDetail ? [`  claim           ${facts.lockDetail}`] : []),
    ...(facts.haltReason ? ['', `  halt reason     ${oneLine(facts.haltReason, 400)}`] : []),
  ];
  return { text: lines.join('\n'), drop: 40 };
}

/** The board, so the session can see this phase in the shape of the whole plan. */
function boardBlock(facts: RecoveryFacts): Block {
  const board = facts.board ?? [];
  if (!board.length) return { text: '', drop: 20 };
  const lines = board.map((row) =>
    `  P${String(row.phase).padEnd(3)} ${row.state.padEnd(12)}${row.title ? ` ${row.title}` : ''}`);
  return { text: ['The board right now:', '', ...lines].join('\n'), drop: 20 };
}

/**
 * What actually failed. Dropped first when the prompt is over budget — it is
 * the one part the session can re-read for itself by running the command.
 */
function evidence(facts: RecoveryFacts): Block {
  const diagnosis = facts.diagnosis;
  if (!diagnosis) return boardBlock(facts);

  const parts: string[] = [];

  const failed = (diagnosis.verification?.ran ?? []).filter((entry) => !entry.ok);
  if (failed.length) {
    parts.push('The verification commands that failed:', '');
    for (const entry of failed.slice(0, 3)) {
      parts.push(`  $ ${oneLine(entry.command, 200)}`);
      if (entry.code != null) parts.push(`  exit ${entry.code}`);
      if (entry.output) parts.push(indent(tail(entry.output, 900)));
      parts.push('');
    }
  } else if (diagnosis.verification && !diagnosis.verification.ok && diagnosis.verification.reason) {
    parts.push(`Verification: ${oneLine(diagnosis.verification.reason, 300)}`, '');
  }

  const notRun = diagnosis.verification?.notRun ?? [];
  if (notRun.length) {
    parts.push('Commands the runner would not execute itself (you must run these yourself):', '');
    for (const entry of notRun.slice(0, 6)) {
      parts.push(`  ${oneLine(entry.text, 160)} — ${oneLine(entry.reason, 120)}`);
    }
    parts.push('');
  }

  if (diagnosis.lint && !diagnosis.lint.ok) {
    parts.push(`Lint: ${oneLine(diagnosis.lint.summary, 400)}`, '');
  }

  if (diagnosis.said) {
    parts.push('What the phase session said as it stopped:', '', indent(tail(diagnosis.said, 700)), '');
  }

  if (diagnosis.workingTree?.length) {
    parts.push('Uncommitted changes in the working tree:', '',
      ...diagnosis.workingTree.slice(0, 25).map((line) => `  ${oneLine(line, 160)}`), '');
  }

  if (diagnosis.resumable && diagnosis.sessionId) {
    parts.push(
      `That phase's own session can still be resumed: claude --resume ${diagnosis.sessionId}`,
      '(useful only if you need its context — you have the facts above either way.)',
      '',
    );
  }

  const board = boardBlock(facts);
  const text = parts.length ? parts.join('\n').trimEnd() : '';
  if (!text) return board;
  return { text: board.text ? `${text}\n\n${board.text}` : text, drop: 10 };
}

/** The issues to repair, named one per line. */
function issueBlock(issues: RecoveryIssue[]): Block {
  if (!issues.length) return { text: '', drop: 30 };
  const lines = issues.slice(0, 25).map((issue) =>
    `  ${issue.severity ? `${issue.severity.padEnd(8)}` : ''}${issue.kind}`
    + `${issue.phase != null ? ` (phase ${issue.phase})` : ''} — ${oneLine(issue.message, 200)}`);
  return { text: ['The issues to repair:', '', ...lines].join('\n'), drop: 30 };
}

/**
 * How to finish, in the terms the skill's conventions use.
 *
 * Never dropped. A session that does the work and commits it wrongly costs
 * more than one that never started: `git add -A` in a monorepo of submodules
 * sweeps up unrelated work, and a pushed branch nobody asked for is somebody
 * else's afternoon.
 */
function discipline(facts: RecoveryFacts): string {
  const branchBullet = facts.gitStrategy
    ? [
      `  · This plan's run works on the plan-wide branch \`${facts.gitStrategy.branch}\`. Commit`,
      '    there — check it out first if the repository is not on it (or use the run\'s linked',
      '    worktree if one exists). Never push the default branch.',
    ]
    : [
      '  · Commit to the branch that is already checked out. Do not git checkout -b, and do',
      '    not push unless the plan says to.',
    ];
  return [
    'How to finish:',
    '',
    '  · Commit with EXPLICIT paths — never git add -A. In a monorepo, commit inside the',
    '    submodule that owns the change.',
    '  · End the commit message with the repository\'s Co-Authored-By: trailer.',
    '  · Verify the sha with git log -1 before you write it into a handoff — never quote a',
    '    sha from memory.',
    ...branchBullet,
    '  · Never git stash to carry work between steps — commit it (a WIP commit if needed).',
    '  · The plan file holds the roadmap and the handoff holds the baton; do not re-list',
    '    the roadmap in the handoff.',
    '',
    'Leave the RECORD as true as the work. When the phase is genuinely done — verification',
    'green, work committed — the paperwork must say so too, or the console goes on calling',
    'it stuck after you fixed it:',
    '',
    '  · the phase handoff\'s frontmatter reads `status: complete` (new-handoff.sh writes',
    '    that; if you repaired an EXISTING blocked/in-progress handoff, edit its frontmatter',
    '    and add what changed to its body — never delete its history);',
    '  · its row in docs/handoffs/<slug>/INDEX.md agrees;',
    '  · the phase lock is released;',
    '  · and when the board then shows EVERY phase done, set the plan\'s own frontmatter to',
    '    `status: complete`.',
    '',
    'The console re-reads the board the moment you exit — what you leave on disk is exactly',
    'what the operator sees. If the work is NOT done, the same rule inverted: a blocked',
    'handoff whose Outstanding section names the real blocker beats a hopeful status.',
    '',
    'When you are done, report in two or three sentences: what was wrong, what you changed,',
    'and what the board says now. If you could NOT fix it, say that plainly instead — an',
    'honest "still broken, here is why" is worth more than a handoff that claims otherwise.',
    '',
    `The operator is watching this terminal. If a real decision is open — which of two`,
    'artefacts is wrong, whether work should be redone — ask here rather than guessing.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Assembly + trimming
 * ------------------------------------------------------------------ */

/**
 * A section of the prompt. `drop` ranks it for removal when the whole thing is
 * over budget — lowest first, so evidence goes before the board, the board
 * before the identifiers, and the instructions never.
 */
export type Block = { text: string; drop?: number };

function keep(text: string): Block {
  return { text };
}

/**
 * Join the blocks, dropping the cheapest evidence until it fits.
 *
 * A recovery prompt is composed from a live board and a real test log, so its
 * length is not knowable when it is written — and the agent path refuses
 * anything over 16 KB outright. Shedding evidence (which the session can
 * re-read by running the command) is always better than shedding instructions.
 */
export function assemble(blocks: Block[], limit = MAX_RECOVERY_PROMPT_BYTES): string {
  const present = blocks.filter((block) => block.text.trim());
  const join = (list: Block[]) => list.map((block) => block.text.trimEnd()).join('\n\n').trim();

  let current = [...present];
  let text = join(current);
  // Ascending drop rank: the most expendable block goes first.
  const ranked = present
    .filter((block) => block.drop != null)
    .sort((a, b) => a.drop! - b.drop!);

  for (const block of ranked) {
    if (Buffer.byteLength(text) <= limit) break;
    current = current.filter((entry) => entry !== block);
    text = join(current);
  }

  // Everything left is load-bearing. Truncating the tail would cut "how to
  // finish", so this is a backstop that should never fire — but a prompt the
  // route refuses is worse than a prompt with a marker in it.
  if (Buffer.byteLength(text) > limit) {
    const marker = '\n\n[truncated by the console — re-read the plan for the rest]';
    const room = limit - Buffer.byteLength(marker);
    text = `${Buffer.from(text).subarray(0, room).toString('utf8').replace(/�+$/, '')}${marker}`;
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Small formatters
 * ------------------------------------------------------------------ */

/*
 * Exported because `runner/failure-context.ts` builds the same kind of thing
 * for a different reader — a phase's own next attempt rather than a repair
 * session — and the two must trim a log the same way. A second `tail()` that
 * cut mid-codepoint or kept the head instead of the end would be a difference
 * nobody chose. Importing them keeps this file a leaf (the dependency points
 * INTO here, never out).
 */

/** Collapse to one line and cap it — a reason field can contain a whole log. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The END of a log is where the failure is; the beginning is setup. */
export function tail(text: string, maxBytes: number): string {
  const trimmed = text.trimEnd();
  if (Buffer.byteLength(trimmed) <= maxBytes) return trimmed;
  const cut = Buffer.from(trimmed).subarray(-maxBytes).toString('utf8').replace(/^�+/, '');
  return `…${cut.slice(cut.indexOf('\n') + 1)}`;
}

export function indent(text: string): string {
  return text.split('\n').map((line) => `  | ${line}`).join('\n');
}
