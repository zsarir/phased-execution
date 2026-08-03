## Stop 6 · Answer what actually needs you

Most tool calls are answered without troubling you. A few are not.

When a session reaches something on the ask list — a commit, a migration, an install — the session
pauses and a card appears on the Autopilot tab and in **Runs**. The card carries the working tree,
the diff, the verification so far and the exact command, so you are answering a question rather than
a prompt.

Nobody answers within about ten minutes and the call is denied, with the reason passed back to the
session so it can adapt or stop rather than hang.

Read-only work never becomes a card. A queue that fills with `grep` and `find` is a queue nobody
reads, and one nobody reads only teaches you to tap yes.

## What "verified" means

Three independent checks have to agree before a phase advances: the plan's verification commands ran
green, `validate.sh` still passes, and the board re-read from disk says *done*.

**And what it does not mean.** Plans write verification as prose with commands embedded — `… -m "not
slow"` is a continuation fragment, and "targeted pytest + safe set" names two suites in English and
no command at all. The runner executes only what is recognisably a command and demonstrably
read-only, and reports every fragment it left behind. On the careful autonomy an incomplete
verification stops the run instead of calling it green. Those fragments are listed against the phase
on the Autopilot tab; they are yours to check.

The classifier is **segment-aware**: a `cd …`, an environment prefix or a wrapper does not hide what
follows it, and every segment of a chained command is gated separately. `FOO=1 ./deploy.sh` and
`… && curl -X POST …` are both caught by that.

## When a phase did the work but is not "done"

A phase can finish its work and still not flip the board — a handoff that was never written, a
verification command that needs re-running, a lint that broke on something unrelated. Rather than
leaving you with only *Retry* (which throws the work away) or *Skip* (which lies about it), the
console offers the verb that matches what is actually missing:

| Verb | Use it when |
|---|---|
| **Recheck** | The work looks done. Re-run verification, lint and the board without spawning anything. |
| **Closeout** | The work is done but the phase never closed itself out — one continuation session that commits, writes the handoff and updates the board. |
| **Resume phase** | The session stopped mid-thought. Continue it with `--resume`, optionally with an instruction. |
| **Retry** | Start the phase again from scratch. The right answer when the attempt was wrong, not merely incomplete. |
| **Skip** | Mark it not-to-be-run. Deliberate, and recorded as such. |

Each phase row can be opened for a **diagnosis**: what the board says, what the verification
actually returned, whether a session is resumable, what is uncommitted in the working tree, and who
holds the lock. A phase that is not done always offers a way forward.

## Stop 7 · The plan closes itself out 🟢

The run reports **finished** when no phase is left outstanding. Each phase has written its handoff
under `docs/handoffs/<slug>/`, which is what a future session — or a future you — reads to pick the
work up cold.

Run the plan's own end-to-end verification, then mark the plan complete.
