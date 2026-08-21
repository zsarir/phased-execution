## Answer what actually needs you

Most tool calls are answered without troubling you. A few are not.

When a session reaches something on the ask list — a commit, a migration, an install — it pauses and
a card appears on the Autopilot tab and in **Runs**. The card carries the working tree, the diff, the
verification so far and the exact command, so you are answering a question rather than a prompt.

Nobody answers within about ten minutes and the call is denied, with the reason passed back to the
session so it can adapt or stop rather than hang.

Read-only work never becomes a card. A queue that fills with `grep` and `find` is a queue nobody
reads, and one nobody reads only teaches you to tap yes.

## What "verified" means

Three independent checks have to agree before a phase advances:

1. The plan's verification commands ran green.
2. `validate.sh` still passes.
3. The board, re-read from disk, says `done`.

All three are run by the runner, not by the session. That is the whole design: a session cannot
verify itself.

## …and what it does not mean

Plans write verification as prose with commands embedded. `… -m "not slow"` is a continuation
fragment; "targeted pytest + safe set" names two suites in English and no command at all.

The runner executes only what is recognisably a command and demonstrably read-only, and **reports
every fragment it left behind** against the phase on the Autopilot tab. Those are yours to check. On
the careful autonomy an incomplete verification stops the run instead of calling it green.

The classifier is **segment-aware**: a `cd …`, an environment prefix or a wrapper does not hide what
follows it, and every segment of a chained command is gated separately. `FOO=1 ./deploy.sh` and
`… && curl -X POST …` are both caught by that.

## When a phase did the work but is not done

A phase can finish its work and still not flip the board — a handoff that was never written, a
verification that needs re-running, a lint that broke on something unrelated. Rather than leaving you
with only *Retry* (which throws the work away) or *Skip* (which lies about it), the console offers the
verb that matches what is actually missing.

| Verb | Use it when |
|---|---|
| **Recheck** | The work looks done. Re-runs verification, lint and the board without spawning anything. |
| **Closeout** | The work is done but the phase never closed itself out — one continuation session that commits, writes the handoff and updates the board. |
| **Resume phase** | The session stopped mid-thought. Continues it with `--resume`, optionally with an instruction. |
| **Retry** | Start the phase again from scratch. The right answer when the attempt was wrong, not merely incomplete. |
| **Skip** | Mark it not-to-be-run. Deliberate, and recorded as such. |

Each phase row opens on a **diagnosis**: what the board says, what verification actually returned,
whether a session is resumable, what is uncommitted, and who holds the lock. A phase that is not done
always offers a way forward.

## Every warning carries its remedy

A dashboard that lists problems and offers nothing is a dashboard you stop reading. Each card under
**Waiting on you** carries the verb that answers it, and each verb works out what it needs rather
than asking you to retype it.

| The card | The verb beside it |
|---|---|
| A halted or interrupted run | **Continue**, **Dismiss**, or an AI recovery — and if the phases it stopped for have since gone green, it is resolved for you before you get there. |
| A stale claim | **Release** — one, or all at once. The owner is read off the lock file, so there is nothing to type. A lease that is still live is refused rather than stolen. |
| Unread notifications | **Mark all read**. |
| A plan that will not parse | The actual issues, each a link to the line, and **Repair the plan with a new agent**. |

## A resolved run is annotated, never deleted

It keeps its status, its halt reason and its place on the Runs page — you can see what happened and
why it no longer demands anything, and undoing that is a click.

What you overrode by hand is remembered as an override, so the next read does not quietly re-derive
it and make the button look broken.

## When runs share a repository

The scheduler serialises runs whose repository scopes overlap — the **repository guard**, on by
default (Settings ▸ Automation). A queued run says who it is waiting on.

Turning the guard off admits overlapping runs at once; a work-branch run that overlaps a live one is
then instructed to do its work inside a linked `git worktree` rather than switching the shared
checkout. The guard never changes the rule *within* one run: two lanes of the same run still never
share a repository.

## The ladder — what it tries before it asks you

A phase that stopped short is never healed by the name of its halt. The console **classifies** it
from evidence that already exists — the board line, the handoff's status and Outstanding text, the
run's record, the lock and who holds it, the working tree, the last verification, what the session
declared — into one **situation**: never started · work in progress · done but unrecorded ·
verification red · declared blocked (a lock, a credential, a gate, something external, or unknown) ·
a resource wall (usage, auth, budget, model) · an unreachable MCP server · a broken plan · a stale or
a live foreign claim · a manual gate · a QA verdict.

Each situation has a **ladder** of rungs, climbed in order and never the same rung twice on one
phase: its own session resumed first (cheap — the context is intact), a fresh briefed session next,
an account or model switch at a wall, one bounded unblock session on a declared blocker, a takeover
of a stale claim. The ladder is bounded in **rungs and dollars** — per phase, per run, per day —
and every cap is a knob on Settings ▸ Automation's ladder card. Every **Ways forward** shows the
situation, the rungs tried with how each ended, and the rung it tries next, so what you press is
never something the machine already tried.

When every rung is spent, or the situation was yours from the start, the phase is parked with
**one errand**: what is needed, how to give it, what was already tried. That card is the only thing
the dashboard's *Waiting on you* shows besides permission cards and sign-ins — a halted run with no
errand is the loop's to climb, not yours to stare at. Do the errand, then press **Recover &
continue**: the board is re-read, what the errand settled stands down, and the run carries on.

## It keeps looking — convergence

Nobody has to be watching. The **convergence loop** re-reads every open plan at boot, on a docs
change, every few minutes (the sweep), a minute after any stop, and on *Recover & continue* — closes
the records the board has overtaken, classifies what is still open, climbs the ladder for runs the
system stopped (never one you paused or stopped, never a resolved one), releases lock debris left
by dead runs and ended sessions, and resumes the lanes a console restart killed. Each pass is one
journal line on the run and one line on the Pulse's **Converge** row — "re-boarded P12 (Never
started → Re-board fresh) · released a stale claim on P3" — so what it did is readable after the
fact. `--no-converge` keeps the automatic passes off; a console without `--allow-run` never
converges by itself. QA is still a press: the loop never dispatches reviewers.

## Who is in the repository

Install the **session-presence hook** (Settings ▸ Session presence, or `phase-console
install-hooks`) and every Claude session on this machine whose directory a console owns reports
itself: a hand-run `claude` appears on the Pulse as a lane of its own kind, its phase lock names its
session, and the lock is a queue to wait in while the session lives and **debris the moment it
ends** — released without waiting for the lease. Presence is three-valued: live, ended, unknown;
nothing is ever released on a guess. A hand session's `phase-outcome.sh` declarations reach the
console too, so a person's *waiting-external* or *partial* drives the same machinery as a lane's.
