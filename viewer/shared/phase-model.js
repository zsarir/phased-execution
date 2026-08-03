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
 * Which controls a row may offer.
 *
 * Every one of these is gated on `phase.state` — the board — and never on the
 * run record. Offering to run a phase the board calls done is the defect this
 * module exists to make impossible.
 */
export function phaseActions(phase, { live, allowRun }) {
  const status = phase.record?.status;
  // A phase that stopped short can always be asked why — including on a console
  // started without `--allow-run`, because reading the evidence changes nothing.
  // Refusing to show it is what sent people to a terminal. The actions inside
  // the panel are the part that is gated.
  const diagnose = !live && phase.state !== 'done'
    && ['failed', 'interrupted', 'parked', 'awaiting-verification'].includes(status);

  if (!allowRun || phase.state === 'done') {
    return { runAlone: false, retry: false, skip: false, diagnose };
  }
  return {
    // Only a phase the board says is ready can be run: anything else is either
    // finished, blocked by a dependency, or already going.
    runAlone: !live && phase.state === 'ready',
    retry: !live && ['failed', 'interrupted', 'parked'].includes(status),
    // Skipping takes a phase off a running loop's list; with no loop there is
    // nothing to take it off.
    skip: Boolean(live) && status !== 'skipped' && status !== 'done',
    diagnose,
  };
}

/** Did the session end up on a different model from the one it was asked for? */
export function fellOverToAnotherModel(record) {
  return Boolean(record?.actualModel && record?.model && !record.actualModel.includes(record.model));
}
