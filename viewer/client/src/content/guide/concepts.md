## A plan is a network

The console reads a phased plan from `docs/plans/` and can execute it: one fresh Claude session per
phase, checked independently, pausing when it needs you.

A plan is a **dependency graph**, not a checklist. Phases are stations; dependencies are track.
"Ready" is derived from the set of finished phases, which is why a plan with 1, 4 and 5 done and 2
and 3 outstanding needs no special handling — it simply begins at 2. There is no cursor to set and no
"current phase" to maintain, so working out of order and resuming a half-finished plan are the same
thing as starting one.

## Who does what

The hardest thing to hold in your head about an unattended runner is which parts it does alone and
which parts wait for a person. It is a short list.

| The machine does this alone | You do this |
|---|---|
| Runs a session per phase, with a fresh context each time | Write the plan, and the two lines a machine reads |
| Runs your verification commands and re-reads the board from disk | Answer an approval card when a session asks |
| Moves to the next ready phase, or stops if none is | Decide a gate the plan declared |
| Writes the handoff and annotates the run | Say what to do about a phase that failed twice |

Everything in the first column happens whether or not a browser is open. Everything in the second
holds the run until you answer — the console will wait, and tell you it is waiting.

## Write the plan

Ask Claude for `/phased-execution` in the repository you want to work in, or scaffold the file
yourself:

```bash
scripts/new-plan.sh my-feature
```

That writes `docs/plans/my-feature.md`. Everything downstream reads it, so this is the one step worth
slowing down for.

## The two lines a machine reads

Most of a plan is prose for whoever reads it next. Two parts are parsed, and have to be exact.

**The phase graph table.** The `Depends on` column decides what is ready. List every prerequisite for
every phase — a cell takes `4`, `4, 5`, a range `1–7`, or `—` for none. A phase that sits alone on
the plan's **Route** tab when you expected it to depend on something is a mistyped cell.

**Each phase's `**Verification:**` line.** The runnable command that proves the phase worked, in
backticks. This is what the autopilot executes to decide whether a phase actually landed — a session
claiming success is not evidence. What counts as verified is worth reading before you rely on it; it
is under **Autopilot**.

## Check it parses

The graph is only as good as the parser thinks it is.

```bash
scripts/validate.sh my-feature
scripts/phase-graph.sh my-feature
```

The first lints the plan; the second prints the board — done, ready, waiting, blocked. If the phase
count differs from the `phases:` field in the front matter, the graph did not parse the way you
meant it to.

## How big a phase should be

A session's cost is roughly linear once the prompt cache is warm, so the limits that actually bite
are **context rot** and **bootstrap overhead**, not turn count. The rule is one coherent, right-sized
chunk of work per session: big enough to amortise the bootstrap, small enough to stay clear of rot.

The plan records a **session budget** (~0.2 × the model's window in phase weight — about 200K for a
1M-class model) and each phase carries a `Size:` of S, M or L. The board's `SUGGESTED BATCHES` line
is that arithmetic already done for you.
