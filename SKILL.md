---
name: phased-execution
description: "Plan and run large multi-phase software work as a sequence of right-sized Claude sessions to control token cost and protect output quality. Use when creating a phased plan for big work, starting or continuing a phase of an existing plan in a fresh session, finishing a phase and handing off, batching or splitting phases to a session budget, resuming a plan mid-DAG, QA-verifying a phase on request, or checking/clearing/approving a phase gate — and whenever the user mentions phased execution, a phase handoff, a plan under docs/plans/, a session budget, a gated phase, or booting the next phase."
argument-hint: "[plan|start|finish] [slug]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
  - TaskCreate
  - TaskUpdate
metadata:
  version: 4.6.0
---

# Phased Execution

Run large work as a sequence of **right-sized sessions** — several adjacent phases usually **share** one
session (batching), and a phase too big for one session is **split**, sized to the model you're running.
The point is twofold: **bound cost** and **protect output quality**. A session only delivers if it can be
**fully bootstrapped from disk** — that's what lets the next one start cold. This skill defines how.

**Sizing is the core idea — `references/sizing.md` is the source of truth; read it.** A warm session's
cost is roughly *linear* (Claude Code caches the prefix), so the levers that actually matter are **context
rot**, **cache-busting events** (model/effort switch, `/compact`, a >5-min idle gap), and **bootstrap
overhead** — not raw turn count. The rule:

> **One coherent, right-sized chunk of work per session** — big enough to amortize bootstrap and keep
> the cache warm, small enough to stay clear of context rot and the harness auto-compaction threshold.

Right size depends on the running model's window, so the plan records a **session budget** (~0.2 × the
window in phase weight — ~200K for 1M-class models) and the engine proposes which phases share a session.
A session boundary is a *cost*, not a virtue: it's earned by a spent budget, an external gate, or a model
switch — never by tidiness.

## Three artifacts + two optional — each has ONE job (never duplicate)

- **Plan** → `docs/plans/<slug>.md` — the durable blueprint: every phase, the dependency graph, the
  session budget, per-phase self-contained detail, end-to-end verification. The roadmap source of truth.
- **Handoff** → `docs/handoffs/<slug>/phase-NN-<title>.md` (+ `INDEX.md`) — the per-phase *baton* for the
  NEXT session: state now, files changed, decisions, exact next commands, skills used. Links back to plan +
  memory. Written at the END of each phase.
- **Memory** → `project_<slug>` in the memory index (the replacement for the removed `remember` plugin) —
  durable cross-session facts: cumulative phase status, commits, deploy/commit gates, gotchas.
- **QA status (OPTIONAL — only when QA is enabled)** → `docs/handoffs/<slug>/test-status.md` (+ reports
  under `docs/handoffs/<slug>/reports/`) — per-phase QA results. **QA is opt-in and off by default**: the
  artifact exists only when the user asked for QA (plan directive `**QA gate:** on`, `new-handoff.sh --qa`,
  or a legacy plan that already has the file). Its existence turns on **QA gating**: a dependent phase is
  `ready` only once every dependency is *verified* (handoff `complete` **and** QA result `pass`/`waived`),
  so a broken phase can't silently propagate. `scripts/phase-graph.sh <slug> --qa-mode` says which regime
  a plan is in (`off` · `on <reason>` · `waived <reason>`).
- **Gate approvals (OPTIONAL — only once a gate is cleared/approved)** → `docs/handoffs/<slug>/gate-status.md`
  — per-phase gate clearances written by `scripts/gate-approve.sh` (the console's Gate card, an AI session
  that verified an `ai` gate, or a hand run). `--gate-status` honours an approved row for **every** gate
  kind. Deliberately a separate file from `test-status.md`: recording an approval must never flip QA
  gating on.

All artifacts live in the **project repo** under `docs/` (versioned + pushed, so any account/machine
can pull and continue); the skill itself lives wherever it was installed. The plan holds the
roadmap; handoffs **link** to it and never re-list all phases. The handoff holds
operational next-session state. Memory holds durable facts. Full schemas/templates:
`references/plan-format.md`, `references/handoff-format.md`, `references/conventions.md`,
`references/sizing.md`.

## Phases are a DAG, not a line

A plan is a **dependency graph**: each phase declares the phases that must finish before it can start.
That makes two things possible that a linear "phase N → N+1" model can't express:

- **Fan-out, run by scope** — when one phase completes it may unblock *several* phases at once. What
  decides whether they may run **at the same time** is their **scope**: the repos they touch, taken from
  the plan's **Repos** column. The invariant: *never two live sessions whose scopes intersect; same repo
  ⇒ serialized; `all` ⇒ exclusive; disjoint ⇒ parallel* (`references/conventions.md` §Scoped concurrency).
  Ask before you start — `phase-lock.sh <slug> conflicts <N> --scope "<csv>"` — and **stop and ask the
  user** on a reported hit. Ready phases may also **share one session** while the budget lasts (execution
  inside a session is serial, so even same-scope siblings are safe that way).
- **Out-of-order progress** — you can complete a deep chain (e.g. 1→4→5) before its siblings (2, 3). The
  system must still know 2 and 3 aren't done. "Finished" means **every** phase is `done`, never "reached
  the highest number".

The engine that makes this real is **`scripts/phase-graph.sh <slug>`**. It reads dependencies from the
plan's `## Phase graph` table and the **live** per-phase status from each handoff's frontmatter, then
classifies every phase as `done | in-progress | ready | waiting` — where **ready = not started and every
dependency done**. Readiness is computed from the done-*set*, so it is always correct under serial and
out-of-order execution. Never hand-maintain a "current phase" cursor; ask the engine. Run it any time to
see the board (and the suggested batches); the other scripts call it to pick next phases and fill handoff
frontmatter.

## Modes

Pick the mode that matches the situation and announce it ("Using phased-execution: <mode>").

### Mode 1 — `plan` (no plan exists yet)
1. **Set the session budget, then minimize phase count.** Identify the model that will *run* these phases —
   you know your own from your system context; if a different model will execute them, ask
   (`AskUserQuestion`; the common split is Fable plans, Opus executes — default `claude-opus-5`). Look up
   its budget in `references/sizing.md` and **author the fewest phases that fit it**: target
   `phase count ≈ ceil(total weight / budget)`, then add a boundary only where one is *earned* — an
   external gate, a deliberate model switch, or a checkpoint the user asked for. Never split for subsystem
   tidiness alone — extra phases buy repeated bootstrap + handoff ceremony. They buy real parallelism only
   when the split falls along **repo boundaries**, since disjoint scopes may run as concurrent sessions;
   splitting inside one repo buys none. Don't author three trivial phases that should be one, or one
   giant phase that should be three (a phase whose weight exceeds the budget is two phases). Record the
   target model + budget in a `## Session budget` note in the plan, and tag each phase's rough
   `- **Size:** S|M|L` (drives the batch engine; default is `M`). **QA is off by default** — only if the
   user asked for QA on this work, record `**QA gate:** on` in that note (see Mode 3 step on QA).
   **If the user named skills to use for this work** (e.g. `design-system`,
   a TDD skill), record them on a `**Skills (every session):**` line in that note — backtick each — so the
   engine re-injects them into every phase's boot prompt (and the QA brief) and each fresh session re-invokes
   them.
   **If the work needs MCP servers** (a browser, an issue tracker, a docs server), record them the
   same way on an `**MCP servers (every session):**` line — backticked *registry ids* from Phase
   Console → MCP, three to six at most. A phase that needs one the rest of the plan does not gets its
   own `- **MCP:** \`server\`` bullet, which is UNIONED with the plan-wide line. The console checks
   them before a phase boards, so a wall costs a probe rather than an hour. By default a server that
   cannot connect does NOT stop the phase: it runs without that server, is told which ones are
   missing and told to record the gap as an operator errand, and the operator is warned. **If a phase
   genuinely cannot proceed without its server, say so** — `**MCP policy:** require` in §Session
   budget, or a per-phase `- **MCP policy:** require` bullet, which overrides the plan-wide one so a
   single phase can carve itself out either way. Use `require` sparingly: a parked phase with no
   other ready phase behind it halts the whole plan.
   Also record the **branch** in that note: by default the branch already
   checked out — **don't create a new branch**; only if the user explicitly asked, create ONE feature
   branch for the whole plan (every phase, including concurrent ones, commits to it) and record its name.
   (The console can also impose a run-level work branch `pe/<slug>` at launch; the plan line stays the
   default for hand-driven sessions.) See `references/conventions.md` §Branches.
2. Draft the plan in the `references/plan-format.md` shape. **Every phase must be self-contained** — written
   so a session with zero prior context can execute it from the plan + its handoff alone. **Required and
   load-bearing: the `## Phase graph` table.** Its `Depends on` column is the machine-readable dependency
   source the engine parses — every phase must list **every** phase that must finish first (comma-separated
   numbers, ranges like `1–7`, or `—` for none). Also fill `Parallel-safe with`, repos, exit criteria, and
   the explicit **"Blocking vs simultaneous"** callout. **Every phase needs a runnable
   `- **Verification:**`** — whole backticked commands or a fenced block proving its exit criteria
   (`validate.sh` warns F14 on any open phase without one; the autopilot parks such a phase at boarding).
   **Gates are categorized.** Mark externally-gated
   phases `*(GATED)*` in their `### Phase N` heading with a `- **Gates (must clear first):** …` line AND a
   category directive `- **Gate-check:** …`:
   - **`ai <one-line check>` — the DEFAULT unless a person is genuinely required.** An AI session can
     verify the conditions, do the work to make them true, and record the clearance itself — the boot
     prompt orders it to. The whole point is to automate; don't strand a human on a gate a session could
     clear.
   - **`manual <who/what>` — only when a person is truly required** (a physical action, a third party,
     credentials no session holds). Then the Gates bullet MUST be full **numbered step-by-step operator
     instructions** — the console renders them on the phase's Gate card next to its Approve button, and
     the boot prompt prints them for whoever is asked.
   - **Self-evaluating checks** (`date` · `phase`/`phases` · `plan` · `deadline`/`by` · `cmd`) when a
     machine can answer directly. Full grammar + the approval lifecycle: `references/plan-format.md`.
3. Scaffold it: `bash ~/.claude/skills/phased-execution/scripts/new-plan.sh <slug>` then fill it in.
4. **Sanity-check the graph + preview batches:** run `scripts/phase-graph.sh <slug>` — it should list every
   phase, show the correct roots as `ready`, and (with `Size:` tags) print `SUGGESTED BATCHES:`. Run
   `scripts/phase-graph.sh <slug> --session-plan <model>` to see the proposed session grouping for your
   budget. If the count is wrong or a phase is missing, the table has a row the parser skipped (odd
   phase-number formatting) — fix it before proceeding.
5. **Commit** the plan (`docs/plans/<slug>.md`).
6. **Immediately implement the root phase(s) in this same session** → switch to Mode 2. (Keep going into
   further ready phases while the budget lasts — see Mode 3 batching; whatever doesn't fit runs in later
   sessions via the pasted prompts from Mode 3 — concurrently where their scopes are disjoint.)

### Mode 2 — `phase-start` (begin or continue a phase in a fresh session)
1. **Bootstrap from disk only:** run `scripts/handoff-status.sh <slug>` — it prints the INDEX, per-file
   status, **and** the live DAG board, so you see at a glance what is done, what this phase depends on, and
   whether it is genuinely `ready`. Read this phase's **dependency** handoffs (the phase's `depends_on`, not
   merely the previous number), `docs/plans/<slug>.md` §Phase N + §Session budget, and memory
   `project_<slug>`. **Invoke any skills named on §Session budget's `Skills (every session):` line** before
   implementing (the boot prompt lists them too). If the plan or the phase names **MCP servers**, confirm
   they are connected (`/mcp`, or `claude mcp list`) before implementing; if one needs authentication,
   **stop and ask the operator to sign it in** rather than working around it — the plan chose that server
   for a reason, and a phase that quietly did without is worse than one that stopped and said why.
   (**Unattended** — no operator present: your boot prompt already names any server the console could
   not reach. Do not improvise a substitute for it and do not treat it as a blocker: do the work that
   does not depend on it, and record what you could not do — naming the server — under **Outstanding**
   in the handoff, as an errand for the operator. Only when the phase genuinely cannot proceed at all,
   record it — `bash scripts/phase-outcome.sh <slug> <N> needs-human --reason "mcp <name> needs
   sign-in"` — hand off `blocked`, and stop.)
   That must be enough — if it isn't, the previous handoff was
   deficient; note the gap so it gets fixed.
2. **Confirm readiness, then the budget.** If the board shows this phase as `waiting`, a dependency isn't
   actually done — stop and surface that rather than building on an unfinished base (earlier-numbered phases
   may legitimately be incomplete; rely on the board, not phase numbers).
   **If the board shows this phase as `in-progress` or `stuck` and the lock is yours-or-stale**, you are
   RESUMING an interrupted session (a died console, a usage-limit stop, a manual pause, a session that
   declared `partial`) — recovery, not a restart: read `git status` and `git diff` FIRST; anything
   uncommitted is the interrupted session's work. Never `git stash`, `git checkout --` or `git reset` it
   away. Re-claim the lock (`--force` only when `status` says the lease expired), then continue from where
   it stopped to the exit criteria — a usage-limit stop says nothing about the work, so fix nothing on
   account of it. (This RESUMING path is exactly what the autopilot drives by itself: a phase it finds
   unfinished boards with a **resume brief** appended to its boot prompt — the handoff's status, the
   uncommitted paths, the last verification, the last session's words — or continues its own session
   with the same instruction; a phase whose handoff reads `blocked` gets ONE **unblock brief**, explicitly
   allowed to do the unblocking work. The brief is the supervisor's snapshot; the repository wins.) Then
   check the plan's
   `## Session budget` target model against the model you're *actually* running — if they differ, recompute
   the budget from `references/sizing.md` and re-batch accordingly. **Then check scope, then claim
   (concurrency guard):** `git pull`, read the phase's scope
   (`scripts/phase-graph.sh <slug> --repos <N>` — the boot prompt already states it), then
   ```
   scripts/phase-lock.sh <slug> conflicts <N> --scope "<csv>" --git   # 0 = clear, 1 = collides
   scripts/phase-lock.sh <slug> claim <N> --scope "<csv>" --git
   ```
   `--owner` defaults to `$PE_OWNER` (which an autopilot exports to its sessions — do not override
   it, or the supervisor cannot release your lock) else `<user>@<host>`. Pass
   `--owner "<account>/<session>"` only when driving phases by hand as one of several people.
   **Pass `--session <id>` when you know your Claude session id** (Phase Console's session-presence hook tells a
   fresh session its id at start; `$PE_SESSION_ID` — runner-injected — or `$CLAUDE_CODE_SESSION_ID` in the
   environment is read automatically, so usually nothing to type): the lock then names its session, and the
   console can show it on the Pulse, queue autopilot lanes behind it while it lives, and release the lock the
   moment the session ends instead of at the end of its lease.
   `conflicts` looks across **every plan**, because a working tree doesn't know which plan asked for it.
   If it names a live session — or `claim` reports the phase already held — **stop and ask the user**
   whether to wait, stop that session, take over (`--force`), or pick a ready phase with a disjoint
   scope. Never build over a live session. (**Unattended**: never wait for an answer that cannot come —
   file `bash scripts/phase-outcome.sh <slug> <N> blocked --reason "lock held by <owner>"
   --watch lock:<slug>/<N>`, hand off `in-progress` if you already did work, and stop; the supervisor
   queues the retry for when the lock frees.) The lock auto-expires (lease) and is released at phase-finish.
   See `references/conventions.md` §Locking + §Scoped concurrency.

   **Gate check — GATED phases only, and BEFORE implementing.** Run
   `scripts/phase-graph.sh <slug> --gate-status <N>` (the boot prompt states the same duty):
   - `clear …` (including `clear (approved by …)`) → proceed.
   - `ai: …` → **the gate is yours to clear.** Verify each condition in the plan's Gates bullet for
     real; where one does not hold yet, DO THE WORK to make it true — clearing this gate is in scope for
     this session. Then record it — `bash scripts/gate-approve.sh <slug> <N> --by ai-session
     --note "<one line of evidence>"` — commit + push `docs/handoffs/<slug>/gate-status.md`, and continue
     into the phase. Only if a condition is genuinely out of reach (missing credentials, a third party):
     STOP, report exactly what is missing and what you verified, and hand the gate to the operator.
   - `manual: …` / `blocked: …` / `OVERDUE: …` → **STOP.** Tell the operator what the gate needs and
     where to clear it: Phase Console → plan → phase → **Gate card** (Approve), or
     `scripts/gate-approve.sh <slug> <N> --by "<who>"`. Never implement past an unapproved human gate.
     (**Unattended**: file `bash scripts/phase-outcome.sh <slug> <N> needs-human --reason "<gate> needs
     the operator"` and stop.)
3. **Reset the task list** (delete prior-phase tasks) and create THIS phase's tasks with subjects prefixed
   **`pN.taskM`** (e.g. `p2.task1 — wire endpoint`). Keep the roadmap in the plan, not the task list.
   (See `references/conventions.md` and memory `feedback_phase_task_list_reset`.)
4. Implement the phase to its exit criteria. Offload high-token exploration/verification to `Agent`
   subagents (they return summaries; the tokens never enter your session) — see Guardrails.

### Mode 3 — `phase-finish` (phase is done)

**Before anything else, create this checklist as tasks (`TaskCreate`) and work it top to bottom.** Step 1
(verify) is the step a hurried finish silently drops, because committing *feels* like the end — the
checklist is what makes it unmissable: **never hand off a phase whose verification is red.**

```
1. VERIFY — run plan §Phase N's Verification commands; ALL green (never hand off red)
2. Commit changed files — explicit paths; verify the sha with: git log -1
3. Write the handoff — new-handoff.sh, then fill frontmatter + body
4. Update memory project_<slug> + its MEMORY.md index line
5. Stop & hand off, or batch — continue while the budget lasts
```

1. **Verify.** Run the phase's own `Verification` commands from plan §Phase N (tests, build, lint —
   whatever the plan names) and confirm **every exit criterion** against them. All green is the bar for
   `status: complete`. If something is red and you can't fix it now, hand off **blocked**
   (`new-handoff.sh <slug> <N> <title> blocked`) with the failure recorded — never a `complete` handoff
   on red verification.
2. **Commit** changed files — explicit paths, never `git add -A`; commit inside the relevant submodule(s);
   end the message with the repo's `Co-Authored-By:` trailer. Commit to the plan's recorded branch — **the
   current branch by default; never `git checkout -b`** unless the user asked and the plan names a branch
   (then that single branch carries *all* phases, sequential and concurrent), or the boot prompt names a
   console-declared run branch — that prompt then owns the branch discipline. **Verify with `git log -1` —
   never copy a sha from memory; the environment may have auto-committed.**
3. **Handoff:** `bash ~/.claude/skills/phased-execution/scripts/new-handoff.sh <slug> <N> <title>`, then
   fill the frontmatter and body (see `references/handoff-format.md`). The script auto-fills `depends_on` +
   `blocks` from the graph and **auto-generates the `## ▶ Start next phase(s)` section with one boot prompt
   per phase this phase unblocks** — review it, don't rewrite it. (It reads the just-finished phase as done,
   so the prompts are correct even before you commit the handoff.) Writing the handoff every phase keeps it
   resumable from a fresh session **even when you batch** the next one.
4. **Memory:** update `project_<slug>` (phase status, commits, gates) + its one-line `MEMORY.md` index
   entry. Record status as a **set** — "done: 1,4,5 / ready: 2,3" — never a single "current phase", so the
   record stays truthful under out-of-order progress. The live board is always recomputable with
   `scripts/phase-graph.sh <slug>`; memory holds the durable narrative, not the cursor.

   **QA gate — only when this plan runs QA.** QA subagents are **opt-in, off by default**; check
   `scripts/phase-graph.sh <slug> --qa-mode`:
   - `off` → skip this entirely (the default — step 1's verification is the phase's quality bar).
   - `waived <reason>` → the plan waived QA: `new-handoff.sh` records the row as `waived` automatically;
     **never dispatch a QA subagent**.
   - `on <reason>` → insert the QA gate here, before step 5: the building session shares the author's
     blind spots, so dispatch an **independent `Agent` subagent with a clean context** using the brief from
     `scripts/phase-graph.sh <slug> --qa-prompt <N>` (discipline: `references/qa-method.md`). It reads the
     real diff cold, runs/extends tests, records `pass|fail|waived` via `qa-record.sh`. Always commit +
     push the report + `test-status.md` (a `fail` must propagate to gate dependents in every clone). On
     `fail`: the finishing session owns the fix — fix now and re-dispatch a **fresh** QA subagent (never
     re-run inside the failed one's context), or hand off blocked
     (`new-handoff.sh <slug> <N> <title> blocked --force`) with the follow-ups listed. Don't start any
     dependent until the verdict is `pass`/`waived`. Batched phases QA one subagent per phase, at each
     phase's own boundary.
   - The user asks for QA on a plan that didn't record it? Pass `--qa` to `new-handoff.sh` (it creates
     `test-status.md`, backfilling earlier completed phases as `waived`), then follow the `on` path.
   **External waits — when the proof depends on a clock you don't control** (a CI image build, a PR's
   auto-merge, a deploy window): do not end the session silently waiting, and do not try to outlive the
   wait with background watchers — in an unattended (`claude -p`) session the process exits when your
   turn ends, `ScheduleWakeup`/`Monitor`/backgrounded loops die with it, and a clean exit with no
   handoff reads as a failed phase. Instead: (1) commit what is done; (2) write the handoff **now** with
   `status: in-progress` — the durable pause marker (`references/handoff-format.md`) — recording what is
   done, what remains, and what you are waiting on; (3) declare the wait machine-readably:
   `bash scripts/phase-outcome.sh <slug> <N> waiting-external --wait-minutes <M> --reason "<what>"
   --watch <ref>`; (4) stop. The supervisor parks the phase and resumes THIS session when the window
   elapses. (An interactive session may instead simply keep the turn and wait.) **A session nobody supervises** (no
   `PE_OUTCOME_FILE` in its environment) writes the same declaration into the console's inbox
   (`runs/<instance>/<slug>/outcomes/phase-NN.json`, printed on stderr); a running Phase Console with `--allow-run`
   picks it up, parks the phase `waiting` and resumes THAT session at the window — a hand-driven session can
   declare its wait and close. Plans avoid the park
   entirely by splitting build ∥ verify-later behind a Gate-check — `references/plan-format.md`.
   **Stopping with work still left — nothing wrong, just out of budget or context:** under a supervisor
   a clean exit with an `in-progress` handoff reads as a failed phase and buys a closeout that is forbidden
   from doing the work. Instead: (1) commit what is done; (2) write the handoff `in-progress` with the
   Outstanding section naming exactly what remains; (3) declare it —
   `bash scripts/phase-outcome.sh <slug> <N> partial --reason <budget|context|other>`; (4) stop. The
   supervisor reads `partial` as *work in progress, resume me* and continues THIS session (or boards a
   fresh one with a resume brief) by itself. (Unsupervised, the same file reaches the console's inbox and
   the console boards the phase again with a resume of your session.) `partial` is for work that remains; `waiting-external` is for
   a clock you don't control; `blocked`/`needs-human` are for things a machine cannot settle.

5. **Stop & hand off, or batch.** If the proof is waiting on an external clock, use the
   §External-waits protocol above — under a supervisor, `phase-outcome.sh … waiting-external`
   is the ONLY channel it can read; prose reads as a failed phase. Then run the
   end-of-phase script (it prints the live board, batching advice,
   and a START COPY / END COPY boot prompt for **every** phase now ready):
   ```bash
   DOCS_ROOT=<hub-root> bash ~/.claude/skills/phased-execution/scripts/next-phase-prompt.sh <slug> <N>
   ```
   Then decide, and **release the phase lock when you stop** (`phase-lock.sh <slug> release <N> --owner … --git`):
   - **Batch (continue in THIS session) — the efficient default.** If a ready phase fits the **remaining
     session budget** (your live context meter, `references/sizing.md`) — sequential on this one *or* an
     independent sibling — just continue into it (Mode 2 in place, lock and all). You save a full
     bootstrap + closeout and keep the cache warm. (`--session-plan` shows which phases belong together.)
   - **Stop & hand off (fresh session)** — when the budget is spent, the next phase is **GATED** (never
     batch past a gate: a 🔒GATED·ai phase's fresh session clears the gate itself, a 🔒GATED·human one
     waits for the operator's approval first), it wants a **different model**, the **account's usage window is
     exhausted** (session/weekly limit — note the reset time in the handoff so the next session knows when
     work can resume, or resumes at once under another account), or — with QA `on` — it depends on this
     phase's still-unrecorded verdict. Print the script's output verbatim as the **last message of this
     session**, then **STOP** — after the handoff exists; a session that stops without one has not
     finished.
   - **Several phases ready:** run them in any order. Ones with **disjoint scopes** may run as separate
     sessions at the same time (the banner names which pairs those are); ones sharing a repo run one at a
     time. Continue into ONE of them here if the budget allows; the output lists a boot prompt for each of
     the rest, and every prompt carries its own `conflicts` check.
   - **No phase ready but work remains:** the just-finished phase unblocked nothing yet (downstream still
     waits on other deps). The script says so; pick up any *other* phase the board shows as `ready`.
   - **Final / all done:** when the board shows every phase `done`, the script prints the closeout — run
     the plan's §End-to-end verification yourself (always), dispatch the fresh **`qa-full` subagent only
     if the closeout prints its brief** (QA-on plans), then mark the plan `status: complete` and check
     memory for user gates. You can also pass `none` to force the closeout.

## Helper scripts (deterministic, output-only — code never enters context)
Run from the repo root that owns `docs/` (in this monorepo, the **superproject root**), or set `DOCS_ROOT`.
Scripts resolve the superproject root automatically when run from inside a submodule directory.
- `scripts/new-plan.sh <slug>` — scaffold `docs/plans/<slug>.md`.
- `scripts/phase-graph.sh <slug>` — **the engine.** Default: the live DAG board (done / ready / waiting,
  with unmet deps, gated flags, and `SUGGESTED BATCHES:` when sizes are present). Machine modes used by the
  other scripts (and handy directly): `--ready`, `--ready-after N`, `--deps N`, `--dependents N`,
  `--gated N`, `--boot-prompt N`, `--size N`, **`--repos N`** (phase N's SCOPE as a normalized csv, read
  from the Repos column — never empty; an undeclared phase reads as `all`),
  **`--session-plan [model|budget]`** (live-aware session
  grouping for a model's budget — done phases excluded, GATED/over-budget/unmet-dep groups flagged),
  **`--lint`** (structural validation: exit non-zero on a malformed row, an undefined
  dependency, or a cycle — naming each), **`--qa-mode`** (this plan's QA regime: `off` · `on <reason>` ·
  `waived <reason>`), **`--qa-result N`** / **`--qa-prompt N`** (recorded QA result /
  the fresh QA-subagent brief), **`--gate-status N`** (evaluate the gate — every type: `phase` `phases`
  `plan` `cmd` `date` `deadline` `by` `manual` `ai`; a recorded approval clears ANY of them; exit 0 clear,
  1 blocked/manual/ai), **`--gate-kind N`** (the gate's category: `human` · `ai` · `auto` · `none`),
  and **`--memory-block`** (the canonical done/ready/waiting block for memory). The board is model-aware
  (batches size to the plan's `## Session budget`) and shows QA markers when gating is on. Parses the
  `## Phase graph` table (deps, ranges, markdown-bold cells) + `### Phase N` `Size:`/`Gate-check:` bullets +
  handoff statuses + `test-status.md` + `gate-status.md`; warns on drift. Sizing/budget constants live in
  `scripts/sizing.env`; the gate vocabulary + category split in `scripts/gates.env`.
- `scripts/new-handoff.sh <slug> <N> <title> [status] [--qa]` — scaffold the phase handoff + create/update
  `INDEX.md`. Auto-fills `depends_on` + `blocks` from the graph and the `## ▶ Start next phase(s)` section
  (a boot prompt per unblocked phase). `status` defaults to `complete`; pass `in-progress`/`blocked`
  mid-phase. Touches `test-status.md` only when the plan's qa-mode is not `off`; `--qa` forces QA on for
  this finish (creates the file, backfilling earlier completed phases as `waived`).
- `scripts/handoff-status.sh <slug>` — INDEX + per-file status + the live DAG board (calls the engine).
- `scripts/next-phase-prompt.sh <slug> <completed-phase|none>` — end-of-phase stop banner, live board,
  batching advice, and a START COPY / END COPY boot prompt for **every** phase the completed phase unblocks
  (on a QA-`on` plan, run it only *after* the verdict is recorded). Pass the phase you just finished (not
  the next number); `none` forces the final-phase closeout (which prints the `qa-full` brief only for
  QA-`on` plans).
- `scripts/validate.sh <slug>` — deterministic validator: structural lint of the plan (F1/F2/F3) **plus**
  handoff body/consistency checks (valid status, required sections, `depends_on` agreeing with the graph).
  Run before trusting a board or finishing a phase.
- `scripts/phase-lock.sh <slug> <claim|release|status|list|conflicts> <N> [--owner ID] [--lease S]
  [--scope CSV] [--git] [--force]` — cooperative phase locks (concurrency guard). Lock files at
  `docs/handoffs/<slug>/.locks/phase-NN.lock`; `--git` pulls before checking and commits+pushes the claim
  so other clones see it (retrying a raced commit/push up to 3×). `--scope` (or `$PE_SCOPE`) records the
  repos the session is working in as a `scope=` line — older locks simply have none, which reads as
  *unknown* and therefore collides with everything. **`conflicts [N] --scope "<csv>"`** is the read-only
  question "does anything live share my working tree?", scanned across **all** plans: exit 0 clear /
  1 conflicts (one line per holder) / 2 usage. `claim` still refuses only the same phase of the same plan —
  scope is policy, and policy lives where it can be acted on. See conventions §Locking + §Scoped concurrency.
- `scripts/qa-record.sh <slug> <N> <pass|fail|waived|pending> --report <rel-path>` — the deterministic,
  idempotent writer for `test-status.md` (the QA gate). The QA subagent calls it when QA is enabled; never
  hand-edit the table. (Recording a row also *activates* gating — it's a QA-on trigger.) See
  `references/qa-method.md`.
- `scripts/gate-approve.sh <slug> <N> [--by WHO] [--note TEXT] [--revoke]` — record (or revoke) a gate
  clearance in `docs/handoffs/<slug>/gate-status.md` — the approval `--gate-status` honours for **every**
  gate kind. Written by the console's Gate card, by an AI session that verified an `ai` gate's conditions,
  or by hand; never hand-edit the table. Deliberately a separate file from `test-status.md` (whose
  existence flips QA gating on). Commit + push it so every clone sees the clearance.
- Tests: `tests/run-tests.sh` runs the bats unit + integration suite (under bash 3.2). **QA is opt-in** —
  when a plan enables it (`**QA gate:** on`, `--qa`, or an existing `test-status.md`), a fresh-context QA
  subagent reviews each phase-finish (brief via `--qa-prompt`) and a `qa-full` pass runs at closeout; the
  discipline lives in `references/qa-method.md`. By default none of that runs — step 1's verification is
  the quality bar.
- **`start`** (→ `viewer/run`) — **Phase Console**, a local web app for reading the whole system: every plan's live
  board, the graph drawn as a route map, phase/handoff detail, copyable boot prompts, portfolio
  statistics and full-text search (`viewer/README.md`). Point a human at it — it is for browsing, not
  for executing a phase; it delegates every status claim to these same scripts and is read-only unless
  started with `--allow-writes` (and never commits or pushes).

## Guardrails
The load-bearing rules a session must not get wrong; full rationale in `references/conventions.md` +
`references/sizing.md`.
- **Right-size; don't reflexively split.** One coherent chunk per session, sized to the running model's
  budget (~0.2 × window in weight); batch any ready phases — sequential or siblings — that fit it, split
  any phase that won't fit alone. A session boundary is earned by budget, gate, or model switch — never
  tidiness. (sizing.md; conventions §Session sizing)
- **Keep the cache warm; offload to `Agent` subagents.** No model/effort switch or `/compact` mid-phase
  (open a fresh session instead). Push broad search, multi-file reads, and independent verification to
  `Agent` subagents — they return only a summary, so the tokens stay out of your session (the biggest
  in-session lever for cost *and* rot); don't over-delegate a lone read or edit. (conventions §Session sizing)
- **`git log -1` is the truth for shas.** Never carry a sha from memory into a handoff; stale "uncommitted"
  claims are the #1 handoff defect. (conventions §Commits)
- **Branches off by default** — commit to the current branch; only on explicit request (or a
  console-declared run branch named in the boot prompt), one branch for the whole plan, every phase on
  it. (conventions §Branches)
- **The handoff is the contract.** If a fresh session can't start cold from it, fix the handoff; link to the
  plan, never re-list the roadmap. (conventions §Memory, §Docs layout)
- **`phase-graph.sh` is the truth for done/ready/next** — never infer from phase numbers or a remembered
  cursor; "finished" means the board shows **every** phase `done`. (conventions §Status source of truth)
- **One session per phase — check scope, then claim the lock** before building (`conflicts` then `claim
  --scope`); if it names a live session, ask the user how to proceed. (conventions §Locking)
- **Scope decides concurrency — one session per working *tree*.** Never two live sessions whose scopes
  intersect; same repo ⇒ serialized; `all` ⇒ exclusive; disjoint ⇒ parallel. **Never `git stash`** to hand
  work across sessions — commit (a WIP commit if needed) instead. (conventions §Scoped concurrency)
- **QA is opt-in; existing gates still bind.** No QA subagent runs unless the plan enables it
  (`--qa-mode` says which regime applies). But once `test-status.md` exists — on ANY plan, old or new — a
  dependent is `ready` only when its deps are `done` **and** QA `pass`/`waived`, and a recorded `fail`
  holds every dependent until re-QA'd: turning QA "off by default" never clears an existing `fail` row.
  **Closing the plan** (`close-plan.sh`) is the only other exit — it retires the report without a re-QA
  because a closed plan claims nothing about progress, and reopening restores the gate untouched.
  (conventions §QA gating)
- **Gates are categorized; approval is the one door.** An `ai` gate is the fresh session's FIRST task —
  verify each condition, do the work to make failing ones true, record it (`gate-approve.sh`), then
  implement; a `manual` (human) gate stops everything until a person does the numbered steps and approves
  (console Gate card or `gate-approve.sh`); auto checks (`date`/`phase`/…) answer by themselves. An
  approval clears ANY kind; `--revoke` restores the gate. Never implement past an unapproved human gate.
  (plan-format §Gates; conventions §Gates)
- **Validate before you trust the board** — `scripts/validate.sh <slug>` catches malformed rows, undefined
  deps, cycles, and inconsistent handoffs; a silently-wrong board is the worst failure.
- **Skill vs work-state split.** The skill lives in its own install (a plugin, or a clone under
  `~/.claude*/skills/`); plans/handoffs/reports/test-status/locks are work-state in the project repo's
  `docs/`. Never write work-state into the skill folder. (conventions §Docs layout & repo split)
