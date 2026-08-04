# What you control

This is the part most people miss. The plan is a plain markdown file, and a handful of lines in it are
**read by the engine**. Change a line, change the behaviour. You can ask Claude for any of these in
plain language at plan time, or edit the file yourself afterwards.

## The control surface at a glance

| You want to… | Put this in the plan | Where |
|---|---|---|
| Choose the executing model | `**Target model:** claude-opus-4-8` | `## Session budget` |
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

