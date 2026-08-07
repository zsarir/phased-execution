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
| Block a phase behind something external | `*(GATED)*` + `- **Gates (must clear first):** …` (numbered steps for human gates) | that `### Phase N` heading |
| Say who can clear that gate | `- **Gate-check:** ai <check>` (a session — prefer) \| `manual <who>` (a person) \| `date 2026-09-01` (itself) | that `### Phase N` block |
| Clear / approve a gate (any kind) | the phase page's **Gate card**, or `gate-approve.sh <slug> <N> --by <who>` | the console · `docs/handoffs/<slug>/gate-status.md` |
| Retire a plan nobody will finish | `status: abandoned` + a reason — set it with `close-plan.sh` | the plan's frontmatter |
| Bring a retired plan back | `close-plan.sh <slug> --reopen` | the plan's frontmatter |
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

Beside the preferences, every launch surface offers two per-run choices when accounts are
registered (`--allow-accounts`): **Account** — which Claude login the run's sessions spend,
including `auto` (most 5-hour headroom) — and **On usage limit** — `switch` (checkpoint and
continue at once under the account with headroom; the dialogs' default), `wait` (sleep to the
reset and resume by itself, restart-safe), or `pause` (checkpoint and stop for a person). A
model-specific limit keeps switching models, not accounts — and files its wall under the model's
own bucket, so `auto` skips that account only for runs of that model. `Switch account` on a live
run acts immediately and lists every account with the current one marked; the scheduler throttles
only the limited account. Accounts rename (display name only) and remove from Settings; an expired
login raises a *Sign in again* alert and a run pinned to it is refused at preflight instead of
burning sessions.

## Stopping things, at three sizes

Three surfaces carry the same verbs, scoped differently. The **run controls** act on the whole run:
*Pause after this phase* (boundary), *Freeze now* (SIGSTOP every session, reversible), *Stop now*
(SIGTERM everything; phases record `interrupted`, never `failed`). Each **session tab** — on the
autopilot page, the Runs page's lanes, and the session console's own toolbar — carries **Freeze/
Continue** and **Stop** for that one session: the rest of the run keeps scheduling, a stopped
phase keeps its session id for Retry, and a queued phase's Stop takes it out of the admission line
before anything spawns. The **fleet rows** on the Runs page carry the run-level Freeze/Continue and
Stop, so a live run is never a row you can only link away from. None of these touch the
consecutive-failure budget, and pressing Start/Continue resets it — a resumed run never inherits a
spent one.

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
scripts/phase-graph.sh <slug> --gate-kind N      # human | ai | auto | none
scripts/phase-graph.sh <slug> --gate-status N    # evaluate the gate (approval clears any kind)
scripts/gate-approve.sh <slug> N --by <who>      # record a clearance (--revoke restores the gate)
scripts/phase-graph.sh <slug> --boot-prompt N    # the copy-paste prompt for phase N
scripts/phase-graph.sh <slug> --session-plan opus   # proposed session grouping
scripts/phase-graph.sh <slug> --qa-mode          # off | on <reason> | waived <reason>
scripts/phase-graph.sh <slug> --qa-result N      # the recorded verdict
scripts/phase-graph.sh <slug> --qa-prompt N      # the QA subagent's brief
scripts/phase-graph.sh <slug> --plan-status      # active | complete | abandoned | superseded
scripts/phase-graph.sh <slug> --closed           # exit 0 if the plan is closed, 1 if open
scripts/phase-graph.sh <slug> --memory-block     # done/ready/waiting, for the memory entry
```

A **closed** plan answers differently on purpose: `--ready` and `--ready-after` come back empty,
`--session-plan` returns a notice instead of groups, `--lint` still lints but exits `0`, and the board
prints a `🔒 CLOSED` banner in place of the ready/waiting/batching lines. `validate.sh` skips it and
`next-phase-prompt.sh` offers no boot prompts. See [the artifacts](artifacts.md#a-plan-can-be-closed).

## The helpers

| Script | What it does |
|---|---|
| `new-plan.sh <slug>` | Scaffold `docs/plans/<slug>.md` from the template. |
| `new-handoff.sh <slug> <N> <title> [status] [--qa] [--force]` | Scaffold the phase handoff, update `INDEX.md`, auto-fill dependencies and generate a boot prompt per unblocked phase. |
| `handoff-status.sh <slug>` | The INDEX, per-file status, and the live board. |
| `next-phase-prompt.sh <slug> <N\|none>` | End-of-phase banner, board, batching advice, and a boot prompt for every newly ready phase. |
| `phase-lock.sh <slug> claim\|release <N> --owner <id> [--force] [--git]` | Claim or release a phase lock. |
| `qa-record.sh <slug> <N> <pass\|fail\|waived\|pending> --report <path>` | Record a QA verdict. |
| `close-plan.sh <slug> [--status abandoned\|superseded\|complete] [--reason "…"] [--reopen] [--force]` | Close a plan that will never finish, or `--reopen` one. Sets `status:`, `closed:` and `closed_reason:`, and releases the plan's own phase locks. Idempotent; never touches git. |
| `validate.sh <slug>` | Full validation — plan structure *and* handoff consistency. |

---

