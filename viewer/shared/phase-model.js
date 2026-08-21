/**
 * What the Autopilot tab shows for a phase, and what it may offer to do to it.
 *
 * Pure, and separate from the component, because this is the part that was
 * wrong: the table was built from `run.phases` — the runner's own bookkeeping —
 * and presented that as the phase's status. On a real plan a phase this run had
 * skipped and another session then finished still read `skipped`, and the
 * console offered to run it again.
 *
 * A run record is a record of what THAT RUN did. It was never the phase's
 * state. `phase-graph.sh` is the only source of truth for done/ready/waiting —
 * the rule the whole console rests on — so the board decides the status and
 * gates every action, and the run record is shown beside it as its own thing.
 */

/** Board states in the order an operator cares about them. */
export const BOARD_ORDER = ['in-progress', 'ready', 'stuck', 'waiting', 'done'];

/**
 * Join the plan's phases (authoritative) to this run's records (historical).
 *
 * Every plan phase appears, whether or not this run touched it — the tab's
 * first job is answering "where is this plan up to?", and it cannot do that
 * from four rows of a fifteen-phase plan.
 */
export function mergePhases(planPhases, run) {
  const records = run?.phases ?? {};
  return planPhases.map((p) => {
    const record = records[String(p.phase)];
    // Finished, but not by this run. Worth saying out loud: the run record
    // beside it reads `skipped` or `failed` and otherwise looks like a defect.
    const elsewhere = Boolean(record) && p.state === 'done' && record.status !== 'done';
    return { ...p, record, elsewhere };
  });
}

/** How many phases sit in each board state. */
export function boardCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return counts;
}

/**
 * Is this phase claimed by a session that is not us, right now?
 *
 * The EXPIRED half is the whole point. A lease that has run out means the
 * session holding it stopped renewing — nobody is working the phase, and the
 * file saying otherwise is debris. Treating that as a live claim is what made
 * a crashed session block work for thirty minutes and then keep blocking it
 * until a person clicked; the runner had exactly this bug, scraping `held by
 * X` out of `phase-lock.sh status` without reading the `(EXPIRED)` beside it.
 *
 * `owner` is who is asking. The autopilot claims phases in its own name, so
 * without this a run would refuse to board the phase it just claimed.
 */
export function heldByOther(lock, owner) {
  if (!lock || lock.expired) return null;
  if (owner && lock.owner === owner) return null;
  return lock;
}

/**
 * Which controls a row may offer.
 *
 * Every one of these is gated on `phase.state` — the board — and never on the
 * run record. Offering to run a phase the board calls done is the defect this
 * module exists to make impossible.
 *
 * A live claim by another session gates the two verbs that START work, and
 * neither of the two that do not: `skip` takes a phase off a running loop's
 * list and `diagnose` only reads evidence. Refusing to explain a phase because
 * somebody else holds it would withhold the very thing that tells you whether
 * their session is still alive.
 */
export function phaseActions(phase, { live, allowRun, owner = null }) {
  const status = phase.record?.status;
  const held = heldByOther(phase.lock, owner);
  const staleLock = Boolean(phase.lock?.expired);
  // A record that stopped short can always be asked why — including on a
  // console started without `--allow-run`, and including when the BOARD calls
  // the phase done. That last one used to be excluded ("nothing left to
  // explain"), and a real page proved it wrong: a run whose verification
  // environment failed showed two red `failed` chips on phases later finished
  // outside it, and offered NOTHING — the one thing those rows still owe is
  // the story of what failed HERE. Reading evidence changes nothing; refusing
  // to show it is what sent people to a terminal. The actions inside the
  // panel are the part that is gated.
  const diagnose =
    !live && ['failed', 'interrupted', 'parked', 'gated', 'awaiting-verification'].includes(status);

  if (!allowRun || phase.state === 'done') {
    return { runAlone: false, retry: false, skip: false, diagnose, heldBy: held, staleLock };
  }
  return {
    // Only a phase the board says is ready can be run: anything else is either
    // finished, blocked by a dependency, or already going.
    runAlone: !live && phase.state === 'ready' && !held,
    // `gated` is retryable on purpose: Retry re-checks the gate, which is
    // exactly the move after approving it on the phase page.
    retry: !live && ['failed', 'interrupted', 'parked', 'gated'].includes(status) && !held,
    // Skipping takes a phase off a running loop's list; with no loop there is
    // nothing to take it off.
    skip: Boolean(live) && status !== 'skipped' && status !== 'done',
    diagnose,
    /** The claim that is stopping `runAlone`/`retry`, so the UI can name it. */
    heldBy: held,
    /** A lapsed claim: worth tidying, never a reason to refuse. */
    staleLock,
  };
}

/** Did the session end up on a different model from the one it was asked for? */
export function fellOverToAnotherModel(record) {
  return Boolean(record?.actualModel && record?.model && !record.actualModel.includes(record.model));
}
