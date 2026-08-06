## Start a run 🟡

Open the plan, go to **Autopilot**, choose a model and an effort, and start. A fresh plan and a
half-finished one use the same button — readiness is derived from what is already done, so there is
nothing to resume and nothing to reset.

The run needs `--allow-run`. Without it the Autopilot tab still shows you everything; it just cannot
start anything.

## What you choose at launch 🟡

Every AI launch — the run form, a phase's *Run only this*, a recovery button, a review — opens on the
same set of choices.

| Choice | What it decides |
|---|---|
| **Model** and **Effort** | Resolved field by field: your choice for this run, then the plan's own `**Model:**` / `**Effort:**` bullets, then the run's defaults. Choosing a model does not throw away an effort the plan asked for. Overridable per phase under *Per phase*. |
| **Account** | Which registered Claude account the sessions run as. Needs `--allow-accounts`. |
| **On usage limit** | `switch` to an account with headroom, `wait` for the window to reopen, or `pause`. A limit on one *model* switches model, not account. |
| **Permission profile** | How much the CLI asks. See **Permissions**. |
| **Skills** | Every skill a session could invoke — yours, this repository's, every installed plugin's. Ticked ones are named in each phase's boot prompt, on top of the plan's own `Skills (every session)` line. |
| **Attach default skills** | Whether this machine's `--default-skills` list rides along. Off unless you turn it on. |
| **QA gate** | Activates the plan's QA gating at start. |
| **Branch** | Puts the whole run on one work branch, `pe/<slug>`, instead of whatever is checked out. |
| **Open a PR** | With **Branch** on, the plan's last phase pushes and opens the PR after one approval tap. |
| **Budgets** | Per phase and per run, in dollars. A phase that hits its cap resumes the *same* session with a larger one rather than starting over, so work already done is kept. |

Settings ▸ Automation holds the defaults these forms open with; each launch can override them for
itself.

## Autonomy — keep going, or stop and ask 🟡

- **Keep going where it safely can** — after a failure it moves to the next ready phase instead of
  stopping. It still halts on two consecutive failures, an exhausted budget, or anything needing a
  person.
- **Stop and ask me** — halts on anything ambiguous: a failed phase, a verification it could not
  fully check, a gate.

## One phase, one process 🟢

Clearing the context between phases needs no mechanism: the process exits and the context goes with
it.

1. **Gate** — if the phase declares one and it is not clear, the phase parks and the runner tries
   another ready phase.
2. **Lock** — the runner checks who holds the phase. It does not take the lock; the session doing the
   work does.
3. **Prompt** — the boot prompt comes from the engine, unaltered.
4. **Session** — one `claude -p` process, streamed to the Autopilot tab as it works.
5. **Verify** — the runner runs the plan's own verification commands itself.
6. **Lint** — `validate.sh` must still pass.
7. **Confirm** — the board is re-read from disk and must say `done`.

> The last three are the point. A session that exits cleanly claiming success while writing nothing
> halts the run, because nothing here takes the session's word for it.

## Watching it 🟢

The session console shows text as it is written, the tool calls it makes, and the work of any
subagent it dispatches — without that last one, a phase that delegates is a silent gap of several
minutes.

**Detail** adds the model's own reasoning and every hook call: worth having when something is wrong,
noise when it is not.

## Asking it something mid-flight 🟡

The box under the console puts a question to the session running *now*. It becomes one more turn in
the same conversation — the context is intact and the phase carries on afterwards — rather than a
reason to stop it. It is framed as out-of-band before it is sent, so an answer does not turn into a
change of direction.

The same question works from any terminal with `btw "…"`.

## Pause, freeze, stop 🟡

Three different things, and the difference matters when a phase is halfway through something.

| Verb | What happens | Getting going again |
|---|---|---|
| **Pause after this phase** | Arms a pause and names the phase that has to finish first. Nothing is cut off. | Cancel it until it arrives, or press Continue after. |
| **Freeze now** | Stops the session where it stands, mid-token, warm and losing nothing. | Continue the frozen session and it resumes instantly. |
| **Stop now** | Interrupts. Records the phase as `interrupted`, not `failed`, because a phase cut off partway may have half-finished something. | Retry the phase, or read what it left behind first. |

## When the plan runs out 🟢

The run reaches the end of its graph and finishes itself: the last handoff is written, the plan is
annotated, and — if **Open a PR** was on — the work branch is pushed and a pull request opened after
one approval tap.

Nothing is deleted. A finished run keeps its journal, its transcripts and its per-phase costs, which
is what makes the **Analysis** tab able to say where the time went.
