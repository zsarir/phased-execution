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
| Let the console heal a stopped run by itself | Settings ▸ Automation ▸ Auto-recover halted runs (and the ladder card's toggles) | the console |
| Bound what it may spend by itself | Settings ▸ Automation · the ladder ▸ Caps (rungs and dollars per phase / run / day) | the console |
| See who is in the repository, and queue behind them | Settings ▸ Session presence ▸ Install (or `phase-console install-hooks`) | the console · `~/.claude/settings.json` |

## Console automation defaults

The console keeps its automation preferences in Settings ▸ Automation (stored per instance under
`~/.config/phase-console/`). The first eight are the **opening values for every launch surface** —
the run form, the phase launcher, the recovery and QA dialogs; each launch can override them for
itself, and the preferences are where "for all plans" is said once. The rest — the ladder card — say
what the autopilot may do **by itself** once a phase stops short, and how much of it
([The loop](loop.md) is the specification). Every one round-trips through `POST /api/prefs`.

| Preference | Default | What it does |
|---|---|---|
| Attach default skills | off | Seed the machine's `--default-skills` list into new runs, and pre-tick it in launch dialogs. |
| QA by default | off | Launch surfaces open with the QA gate ticked, so starting a run activates QA for the plan (needs `--allow-writes`; earlier finished phases are backfilled `waived`). |
| Branch | current branch | `Work branch per run` puts every console-minted session of a run on one plan-wide branch, `pe/<slug>` — created from the default branch if missing, reused by later phases. |
| Open a PR at completion | on | Work-branch runs only: the plan's **last** phase is told to push `pe/<slug>` and open a PR per scoped repo. For that run — and only that run — bare `git push` moves from the deny wall to an approval card, and `gh pr create` stays a card even under the `trusted` profile; force-pushes and `--delete` stay denied outright. |
| Repository guard | on | The scheduler queues runs whose repository scopes overlap. Off: overlapping runs may start together, and a work-branch run sharing a repo with a live one is told to work in a linked `git worktree` instead of switching the shared checkout. |
| When an MCP server is unavailable | Continue and warn | The phase boards without the servers that would not answer, its prompt names them and tells it to record the gap under **Outstanding** as an errand, and you are told once per run per server. `Park the phase` is the older behaviour — use it when the work genuinely cannot proceed, remembering that a run whose ready phases have all parked has nothing left to start. Settable per run in the launch dialog and per phase in the run's phase matrix; a plan's own `**MCP policy:** require` outranks both the run choice and this preference. |
| Auto-recover halted runs | on | New runs opt into the ladder (`autoRecoverByDefault`): a stopped phase is classified and climbed by itself, within the caps below; off, every stop is yours. |
| Continue runs a recovery fixed | on | When a recovery leaves the board reading fixed, the run resumes by itself (`autoContinueRecovery`). |
| Rungs per phase · Spend per phase | 3 · $100 | The ladder's per-phase caps (`ladderPerPhaseRungs`, `ladderPerPhaseUsd`) — how many rungs one phase may climb and what they may cost before its errand is written. |
| Rungs per run · Spend per run | 10 · $400 | The per-run caps (`ladderPerRunRungs`, `ladderPerRunUsd`); the one automatic budget raise stays inside the USD cap. |
| Spend per day | $600 | Across every run this console drives in a day (`ladderPerDayUsd`). |
| Sweep every | 5 min | How often the convergence loop re-reads every open plan even when nothing happened (`convergeEveryMs`; 0 turns the timer off — boot, a docs change and the minute after a stop always run a pass). |
| Park on a required MCP server for | 30 min | A phase parked by the `require` policy continues without the server after this long, an errand recorded (`mcpRequireTimeoutMs`; 0 waits for it to heal, however long). |
| Raise a spent run budget once by | 25 % | The resource ladder's one budget raise, within the per-run cap (`budgetAutoRaisePct`; 0 never raises). |
| Unblock attempts | on | A handoff marked blocked for a reason no machine category fits gets ONE bounded session allowed to do the unblocking work — then an errand (`unblockAttempts`). |
| Take over stale claims | on | An expired foreign lock over unfinished work is taken over and the work continued; a live session's claim is never touched (`staleClaimTakeover`). |
| Resume killed lanes at boot | on | A lane a console restart killed resumes its own session when the console is back — at most 3 restarts in a row per phase, then an errand (`resumeAtBoot`). |
| Switch accounts at a wall | on | A signed-out run account, or a usage window too far out to sleep on, switches to a registered account that can pay (`autoAccountSwitch`); off, the wall halts with an errand. |

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

## What it does by itself, and what it asks you

Since 2.3.0 a stopped phase is not a dead end. The console **classifies** it — never started, work
in progress, done but unrecorded, verification red, declared blocked (lock · credential · gate ·
external · unknown), a resource wall (usage · auth · budget · model), an unreachable MCP server, a
broken plan, a stale or a live foreign claim, a manual gate, a QA verdict — and **climbs that
situation's ladder**: its own session first (`--resume`), a fresh briefed session next, an account or
model switch at a wall, one bounded unblock session on a declared blocker, a takeover of a stale
claim. The **convergence loop** runs it at boot, on a docs change, every sweep, a minute after any
stop, and on **Recover & continue**. When every rung is spent — or the situation was yours from the
start — it leaves **one errand**: what is needed, how to give it, what was already tried. You see
the ladder on every **Ways forward** group (the situation chip, the rungs tried, the next rung, or the
errand card), the errands and nothing else under the dashboard's **Waiting on you**, each plan's last
pass on the Pulse's **Converge** line, and the caps and toggles above. Sessions see each other
through the **session-presence hook** (Settings ▸ Session presence, `phase-console install-hooks`):
a hand-run `claude` in the repository shows on the Pulse, its lock is a queue to wait in while it
lives and debris the moment it ends, and its `phase-outcome.sh` declarations drive the same machinery
as a lane's. What stays yours: a sign-in, a manual gate, a credential, a blocker no category fits,
QA, anything destructive or published. [The loop](loop.md) has every word of it.

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
| `phase-lock.sh <slug> claim\|release\|status\|list\|conflicts <N> [--owner <id>] [--scope <csv>] [--session <id>] [--force] [--git]` | Claim, release or inspect a phase lock; `conflicts` asks across every plan whether a live session shares your scope. `--session` (default `$PE_SESSION_ID`, else `$CLAUDE_CODE_SESSION_ID`) names the session in the lock, so the console can release it the moment that session ends. |
| `phase-outcome.sh <slug> <N> complete\|blocked\|needs-human\|waiting-external\|partial [--reason …] [--wait-minutes M] [--watch ref]` | Declare how a session ended, machine-readably — the runner's channel (`PE_OUTCOME_FILE`); unsupervised, it lands in the console's inbox and is picked up the same way. |
| `session-hook.sh` | The user-scope Claude Code hook (SessionStart · Stop · SessionEnd) that reports a session to the console owning its directory; installed by `phase-console install-hooks` or Settings ▸ Session presence. Fail-open; `PHASE_CONSOLE_HOOK_OFF=1` silences it. |
| `qa-record.sh <slug> <N> <pass\|fail\|waived\|pending> --report <path>` | Record a QA verdict. |
| `close-plan.sh <slug> [--status abandoned\|superseded\|complete] [--reason "…"] [--reopen] [--force]` | Close a plan that will never finish, or `--reopen` one. Sets `status:`, `closed:` and `closed_reason:`, and releases the plan's own phase locks. Idempotent; never touches git. |
| `validate.sh <slug>` | Full validation — plan structure *and* handoff consistency. |

---

