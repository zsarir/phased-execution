## A plan is a network

The console reads a phased plan from `docs/plans/` and can execute it: one fresh Claude session per
phase, checked independently, pausing when it needs you.

A plan is a **dependency graph**, not a checklist. Phases are stations; dependencies are track.
"Ready" is derived from the set of finished phases, which is why a plan with 1, 4 and 5 done and 2
and 3 outstanding needs no special handling — it simply begins at 2. There is no cursor to set and
no "current phase" to maintain.

The single hardest thing to hold in your head about an unattended runner is **which parts it does
alone and which parts wait for a person**. That distinction organises this guide:

- 🟢 **The machine does this** — running a session, verifying, re-reading the board.
- 🟡 **You do this** — writing the plan, answering a card, deciding a gate.

## Stop 1 · Write the plan

This is the one step worth slowing down for: everything downstream reads it.

Ask Claude for `/phased-execution` in the repo you want to work in, or scaffold the file yourself:

```bash
scripts/new-plan.sh my-feature
```

That writes `docs/plans/my-feature.md`. Two parts of it are read **by machine** and have to be
exact:

**The phase graph table.** The `Depends on` column is parsed to work out what is ready. List every
prerequisite for every phase. A cell takes `4`, `4, 5`, a range `1–7`, or `—` for none.

**Each phase's `**Verification:**` line.** The runnable command that proves the phase worked. Write
real commands in backticks — this is what the autopilot executes to decide whether a phase actually
landed. What "verified" means is worth reading before you rely on it; it is in the **Autopilot**
section.

## Stop 2 · Check it parses

The graph is only as good as the parser thinks it is.

```bash
scripts/validate.sh my-feature
scripts/phase-graph.sh my-feature
```

The first lints the plan. The second prints the board: which phases are done, ready, waiting or
blocked. If the phase count differs from the `phases:` field in the front matter, the graph did not
parse the way you meant it to.

Open the plan's **Route** tab to see the same graph drawn. A phase that sits alone when you expected
it to depend on something is a mistyped `Depends on` cell.

## Sizing, briefly

A session's cost is roughly linear once the prompt cache is warm, so the limits that actually bite
are **context rot** and **bootstrap overhead** — not turn count. The rule is one coherent,
right-sized chunk of work per session: big enough to amortise the bootstrap, small enough to stay
clear of rot.

The plan records a **session budget** (~0.2 × the model's window in phase weight — about 200K for a
1M-class model) and each phase carries a `Size:` of S, M or L. The board's `SUGGESTED BATCHES` line
is that arithmetic done for you.

One nuance about branches: the plan's `**Branch:**` prose governs hand-driven sessions, while a
console run can impose its own work branch (`pe/<slug>`) at launch — when the two disagree, the
session is told about the mismatch and records it in its handoff.
