# Safety rails

Things that stop the system hurting you, all of them mechanical.

**Phase locks.** Starting a phase claims it — a small lock file in your repo recording who holds it,
a lease that auto-expires, and the **scope** it is working in. If a second session finds the phase held
by a live session, it stops and asks rather than building the same phase twice. Locks are committed, so
they work across machines and accounts.

**Scope decides who may run beside you.** What makes two sessions dangerous is a shared *working tree*,
not the mere fact of being two — so the rule is about scope: *never two live sessions whose scopes
intersect; same repo ⇒ serialized; `all` ⇒ exclusive; disjoint ⇒ parallel.* Scope comes from the plan's
Repos column, and `phase-lock.sh <slug> conflicts <N> --scope "<csv>"` answers the question across every
plan before you start — a working tree doesn't know which plan asked for it. Every boot prompt states
its phase's scope and the command to check it. A phase that declares nothing counts as `all` and runs
alone; still want to overlap two sessions on one repo? Give each its own checkout or `git worktree`.

**Never stash to hand off.** A `git stash` lives in one working tree and is invisible to every other
session and clone. Commit instead — even a WIP commit. The filesystem of a closed session is not a
channel; git is.

**Verification before handoff.** A phase's own verification commands must be green before it can be
handed off as complete. Red work is handed off as `blocked`, with the failure recorded, so the board
shows the truth.

**Structural validation.** `scripts/validate.sh <slug>` catches malformed graph rows, dependencies on
phases that do not exist, cycles, invalid handoff statuses, missing required sections, and handoffs
whose declared dependencies disagree with the plan. Run it before trusting a board.

**Explicit-path commits.** Never `git add -A` — a phase commits the files it touched, so unrelated
work in your tree is not swept in.

---

