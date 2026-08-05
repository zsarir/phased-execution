# What you control

This is the part most people miss. The plan is a plain markdown file, and a handful of lines in it are
**read by the engine**. Change a line, change the behaviour. You can ask Claude for any of these in
plain language at plan time, or edit the file yourself afterwards.

## The control surface at a glance

| You want to… | Put this in the plan | Where |
|---|---|---|
| Choose the executing model | `**Target model:** claude-opus-5` | `## Session budget` |
| Change how much work fits a session | `**Budget:** ~200K weight/session` | `## Session budget` |
| Use a different model for one phase | `- **Model:** haiku` | that `### Phase N` block |
| Say how big a phase is | `- **Size:** S` \| `M` \| `L` | that `### Phase N` block |
| Turn QA on | `**QA gate:** on` | `## Session budget` |
| Turn QA off explicitly | `**QA gate:** off` | `## Session budget` |
| Commit to a specific branch | `**Branch:** feature/checkout` | `## Session budget` |
| Force skills into every session | ``**Skills (every session):** `design-system` `` | `## Session budget` |
| Say a phase depends on others | the `Depends on` column | `## Phase graph` table |
| Block a phase behind something external | `*(GATED)*` + `- **Gates (must clear first):** …` | that `### Phase N` heading |
| Make that gate machine-checkable | `- **Gate-check:** date 2026-09-01` | that `### Phase N` block |
| Put a console run on one work branch | Settings ▸ Automation ▸ Branch (or the launch form) | the console |
| Open a PR when the plan completes | Settings ▸ Automation ▸ Open a PR (needs the work branch) | the console |
| Queue runs whose repos overlap | Settings ▸ Automation ▸ Repository guard | the console |

## Console automation defaults

The console keeps five preferences (Settings ▸ Automation, stored in
`~/.config/phase-console/config.json`) that are the **opening values for every launch surface** —
the run form, the phase launcher, the recovery and QA dialogs. Each launch can override them for
itself; the preferences are where "for all plans" is said once.

| Preference | Default | What it does |
|---|---|---|
| Attach default skills | off | Seed the machine's `--default-skills` list into new runs, and pre-tick it in launch dialogs. |
| QA by default | off | Launch surfaces open with the QA gate ticked, so starting a run activates QA for the plan (needs `--allow-writes`; earlier finished phases are backfilled `waived`). |
| Branch | current branch | `Work branch per run` puts every console-minted session of a run on one plan-wide branch, `pe/<slug>` — created from the default branch if missing, reused by later phases. |
| Open a PR at completion | on | Work-branch runs only: the plan's **last** phase is told to push `pe/<slug>` and open a PR per scoped repo. For that run — and only that run — bare `git push` moves from the deny wall to an approval card, and `gh pr create` stays a card even under the `trusted` profile; force-pushes and `--delete` stay denied outright. |
| Repository guard | on | The scheduler queues runs whose repository scopes overlap. Off: overlapping runs may start together, and a work-branch run sharing a repo with a live one is told to work in a linked `git worktree` instead of switching the shared checkout. |

**Run-level beats plan prose for console-minted sessions.** When a run uses the work branch and the
plan's own `**Branch:**` line names a different branch, the session is told to use the run's branch
and to record the discrepancy in its handoff — the console never silently rewrites the plan.
Hand-driven sessions (copy-paste boot prompts) keep following the plan's line.

# Command reference

Run these from the repository that owns `docs/`, or set `DOCS_ROOT`.

## The engine

```bash
scripts/phase-graph.sh <slug>                    # the board (default)
scripts/phase-graph.sh <slug> --lint             # structural validation; non-zero on a problem
scripts/phase-graph.sh <slug> --ready            # ready phase numbers
scripts/phase-graph.sh <slug> --ready-after N    # the ready set assuming N just completed
scripts/phase-graph.sh <slug> --deps N           # N's prerequisites
scripts/phase-graph.sh <slug> --dependents N     # phases N blocks
scripts/phase-graph.sh <slug> --size N           # S | M | L
scripts/phase-graph.sh <slug> --gated N          # yes | no
scripts/phase-graph.sh <slug> --gate-status N    # evaluate the machine gate
scripts/phase-graph.sh <slug> --boot-prompt N    # the copy-paste prompt for phase N
scripts/phase-graph.sh <slug> --session-plan opus   # proposed session grouping
scripts/phase-graph.sh <slug> --qa-mode          # off | on <reason> | waived <reason>
scripts/phase-graph.sh <slug> --qa-result N      # the recorded verdict
scripts/phase-graph.sh <slug> --qa-prompt N      # the QA subagent's brief
scripts/phase-graph.sh <slug> --memory-block     # done/ready/waiting, for the memory entry
```

## The helpers

| Script | What it does |
|---|---|
| `new-plan.sh <slug>` | Scaffold `docs/plans/<slug>.md` from the template. |
| `new-handoff.sh <slug> <N> <title> [status] [--qa] [--force]` | Scaffold the phase handoff, update `INDEX.md`, auto-fill dependencies and generate a boot prompt per unblocked phase. |
| `handoff-status.sh <slug>` | The INDEX, per-file status, and the live board. |
| `next-phase-prompt.sh <slug> <N\|none>` | End-of-phase banner, board, batching advice, and a boot prompt for every newly ready phase. |
| `phase-lock.sh <slug> claim\|release <N> --owner <id> [--force] [--git]` | Claim or release a phase lock. |
| `qa-record.sh <slug> <N> <pass\|fail\|waived\|pending> --report <path>` | Record a QA verdict. |
| `validate.sh <slug>` | Full validation — plan structure *and* handoff consistency. |

---

