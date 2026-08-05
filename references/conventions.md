# Conventions

Contents: Slug · Task ids · Commits · Branches · Memory · Status source of truth ·
Phase dependencies (the DAG) · Session sizing & hygiene · Helper scripts · Locking ·
Scoped concurrency · QA gating (opt-in) · Docs layout & repo split · Multi-repo commit atomicity

## Slug
- kebab-case, derived from the work: `crm-import-contacts`, `submission-approval-fix`.
- The **same slug** names the plan (`docs/plans/<slug>.md`), the handoff folder
  (`docs/handoffs/<slug>/`), and the memory entry (`project_<slug>`) — so one grep finds all three.
- **Memory-key override:** if this work extends an existing tracked project, the plan's `memory:`
  frontmatter may point to a pre-existing `project_<other>` key rather than `project_<slug>`. Document
  the deviation inline (e.g. a `# reuses project_sa_crm_app_gaps` comment). The slug still names the
  plan + handoff folder; only the memory key differs.

## Task ids — `pN.taskM`
At `phase-start`, **reset** the task list (delete prior-phase tasks) and create the new phase's tasks with
subjects prefixed `pN.taskM`:
- `p1.task1 — add migration file`
- `p1.task2 — mirror canonical SQL`
- `p1.task3 — update prisma + republish layer`
Keep the broad roadmap in the plan, never in the task list. (Memory: `feedback_phase_task_list_reset`.)

## Commits (per phase)
- Stage **explicit feature paths**, never `git add -A` — submodules carry unrelated uncommitted work.
- Commit **inside** the relevant submodule(s); the parent `hub` repo only tracks submodule pointers, so a
  phase touching two submodules makes one commit in each, then (if desired) a pointer-bump in the superproject.
- End the message with the repo's `Co-Authored-By:` trailer.
- One phase = one logical commit per repo (squash WIP before finishing).
- **Verify the sha:** run `git log -1` after committing — never carry a sha from memory into the next
  handoff without checking. The environment may auto-commit (hooks); confirm the actual sha/message.

## Branches
- **Default: do NOT create a branch — commit to the branch already checked out.** Creating a branch is the
  user's call; only create one when the user **explicitly asks**. This keeps a plan from scattering work
  across branches the user never wanted.
- **When the user does ask for a branch, use exactly ONE branch for the whole plan** and commit **every**
  phase to it — including independent phases that run in **separate sessions**, whether those sessions run
  one after another or at the same time on disjoint scopes. They touch disjoint files, so sharing one
  branch is safe; do **not** open a branch per phase or per session — that over-branching is exactly what
  to avoid. One feature branch per repo (submodule) for the entire plan.
- **Record the branch in the plan** (the `## Session budget` note's `Branch:` line) so every fresh session —
  sequential or independent — checks out the SAME branch. Create the branch **once** (at plan time, if the
  user asked); later sessions `git checkout <branch>`, **never** `git checkout -b`.

## Memory (the `remember` replacement)
At each phase boundary, update the durable memory:
- `project_<slug>.md` in `~/.claude/projects/<proj>/memory/` — frontmatter (`name`, `description`,
  `metadata.type: project`) + body: phase status, commits/shas, deploy/commit gates, gotchas.
- Add/refresh the one-line pointer in `MEMORY.md`: `- [Title](project_<slug>.md) — hook; [[links]]`.
- Cross-link related memories with `[[name]]`.
- Memory = durable facts that must outlive the docs. Handoff = operational next-session state. Plan =
  roadmap. Don't duplicate across them.

## Status source of truth
Status is **computed, not a stored cursor.** `scripts/phase-graph.sh <slug>` reads each handoff's
`status:` frontmatter + the plan's Phase-graph table and classifies every phase
`done | in-progress | ready | waiting`. INDEX.md + per-handoff `status:` are the inputs it aggregates —
keep them accurate; the plan's "Exit criteria" column is the *definition* of done but secondary. Don't
hand-maintain a "current phase". **A plan is finished only when the board shows EVERY phase `done`**, never
when the highest-numbered phase is reached.

## Phase dependencies (the DAG)
- The plan is a dependency graph. A phase's `Depends on` lists **every** phase that must finish first;
  `scripts/phase-graph.sh` parses that column (numbers, comma lists, ranges like `1–7`, `—` for none).
- **ready = not started AND every dependency `done`.** Readiness is computed from the done-*set*, so it is
  correct however the phases are run — one completion unblocking several, sessions running side by side, or
  **out-of-order** execution (finishing a deep chain like 1→4→5 before siblings 2,3 — the board still shows
  2,3 as not-done, and the project isn't finished until they are).
- Two phases are **parallel-safe** only if neither depends on the other **and** their **scopes are
  disjoint** (§Scoped concurrency — the Repos column is the machine-readable form of "disjoint files").
  Independent `ready` phases run in *separate* fresh sessions, simultaneously when their scopes allow it
  and one at a time when they don't; `next-phase-prompt.sh` lists a boot prompt for each and says which
  pairs are which.
- `new-handoff.sh` auto-fills each handoff's `depends_on` (prerequisites) + `blocks` (dependents) from the
  graph, so every handoff is self-describing. Don't hand-edit those to disagree with the plan table.

## Session sizing & hygiene
- **Right-size; don't reflexively split.** Aim for one coherent chunk of work per session, sized to the
  running model's budget (~0.2 × window in phase weight; `references/sizing.md`). Several phases usually
  share a session: any **ready** phase — sequential on the one just finished *or* an independent sibling —
  that fits the **remaining budget** should be **batched** into the same session; it saves a full
  bootstrap + closeout and keeps the prefix cache warm. Open a fresh session (`/clear`) when the budget is
  spent, at a GATED phase, to switch model, or — with QA on — when the next phase depends on a
  still-unrecorded verdict.
- **Session budget is computed, not stored.** Like status, it's derived from the plan's `## Session budget`
  note + `references/sizing.md` + the model you're running — never a per-handoff field. `scripts/phase-graph.sh
  <slug> --session-plan <model>` proposes the grouping; you confirm it.
- **Keep the cache warm.** Don't switch model/effort level or run `/compact` mid-phase — each busts the
  prefix cache (a full-price re-read); start a fresh session instead.
- The plan-creating session also runs Phase 1 (no `/clear` between plan and phase 1), and may batch on into
  Phase 2+ under the same rule.
- **Bootstrap via INDEX, not folder mtime.** At Mode 2 start, run `scripts/handoff-status.sh <slug>` or
  read `docs/handoffs/<slug>/INDEX.md` to find the correct handoff for this phase. Early phases may live in
  a legacy flat file the INDEX references — don't rely on picking the newest file in the folder.
- If a handoff can't bootstrap a cold session, it's the bug — fix the handoff, not the next session.

## Helper scripts
`scripts/` resolve their own location and the docs root. **Root resolution is superproject-aware:** scripts
try `git rev-parse --show-superproject-working-tree` first (avoids resolving to a submodule root when cwd
is inside a submodule), then fall back to `--show-toplevel` / `pwd`. If `docs/` is not found under the
resolved root, scripts exit with a clear error message (and note when you're not inside a git repo). Always
run scripts from the repo root or set `DOCS_ROOT=/path/to/repo` explicitly when inside a submodule directory.

## Locking (concurrency guard)
- A phase started in a session is **claimed**: `scripts/phase-lock.sh <slug> claim <N> --owner
  "<account>/<session>" --scope "<csv>" --git` writes `docs/handoffs/<slug>/.locks/phase-NN.lock`
  (owner + lease + scope) and — with `--git` — commits+pushes it so other clones see it on their next pull.
  A raced commit or push is retried (pull --rebase, up to 3×) rather than dropped.
- **`git pull`, then ask two questions, before you build.** *Is the phase taken?* — `claim` answers it and
  refuses a live holder. *Does anything live share my working tree?* — `phase-lock.sh <slug> conflicts <N>
  --scope "<csv>"` answers it across **every plan** (exit 0 clear / 1 conflicts / 2 usage). On either
  refusal **stop and ask the user**: wait, stop the other session, `--force` take over, or start a ready
  phase with a disjoint scope. Never build a phase two sessions hold at once.
- `claim` deliberately enforces only the *same-phase* rule, never scope. Policy belongs where it can be
  acted on (the console's scheduler, or a session that can ask a human), and keeping `claim` unchanged is
  what lets an older script and an older console keep working against a scoped lock.
- `scope=` is optional in the file. **Absent means UNKNOWN, and unknown collides with everything** — a lock
  written before scopes existed must never read as harmless.
- Leases auto-expire (default 30 min) so a dead session's lock can be taken over; refresh by re-claiming.
  Release at phase-finish (`phase-lock.sh <slug> release <N> --owner … --git`). Cooperative, not a hard mutex.

## Scoped concurrency (working-tree safety)
- **The invariant: never two live sessions whose scopes intersect. Same repo ⇒ serialized; `all` ⇒
  exclusive; disjoint ⇒ parallel.** What makes two sessions unsafe is a shared *working tree* — they
  overwrite each other's files mid-edit and tests fail for unrelated reasons — not the mere fact of being
  two. So the rule is about scope, not about counting sessions.
- **Scope = the plan's Repos column**, normalised by `shared/scope.js` (JS) and `scripts/scope.sh` (bash);
  `phase-graph.sh <slug> --repos <N>` prints it. `all` and an *undeclared* cell touch everything. A path
  token nests segment-wise: `packages` ∩ `packages/cart-api` collide, `api` and `api-gateway` do not.
  Ambiguity always resolves toward colliding — a false conflict costs parallelism, a missed one corrupts a
  tree.
- **Two sessions on the same repo still need their own checkouts if you insist on overlapping** — a
  separate clone or a `git worktree`, never one shared directory. The scope rule is what tells you when you
  don't need that at all. The console automates exactly this escape hatch: with its repository guard
  turned off, a work-branch run that overlaps a live one is instructed to `git worktree add` and do the
  phase's work inside the linked worktree rather than switching a shared checkout.
- **Handoff, INDEX and lock commits in the docs repo are NOT part of a phase's scope.** Every session
  writes there, and treating it as scope would serialise the whole system. Git's own `index.lock` plus a
  pull-rebase retry (≤3) is the serialization; the scripts do it, and a session that races a commit or push
  should rebase and retry rather than give up.
- **Never `git stash` to hand work to another session.** A stash lives in one working tree and is invisible
  to any other session or clone — the classic "I stashed it but the other session can't see it" trap.
  Instead **commit** (a WIP commit is fine) and let the next session continue from the commit; squash WIP
  before the phase-finish commit.
- **Commit before you switch, pull before you start.** End a session on a clean, committed tree; the next
  session `git pull`s (and `phase-lock.sh … conflicts` / `… claim`s) before touching anything. The
  filesystem of a closed session is not a channel — git is.

## QA gating (opt-in — verify before dependents start)
- **QA is opt-in, off by default.** No QA subagent runs and no `test-status.md` is created unless the plan
  enables QA: a `**QA gate:** on` line in §Session budget (recorded at plan time when the user asked),
  `new-handoff.sh --qa` at a finish (the user asks now), or a plan that already has `test-status.md`
  (legacy). A plan-recorded **waiver** (`**QA gate:** off`, or legacy "QA gate: WAIVED…" prose) means rows
  are recorded as `waived` and a subagent is **never** dispatched — the finishing session's own
  §Verification run is the quality bar. `phase-graph.sh <slug> --qa-mode` reports the regime
  (`off` · `on <reason>` · `waived <reason>`).
- **When QA is on:** at each phase-finish the skill dispatches a **fresh-context QA subagent** (an `Agent`
  with a clean context — independent of the builder's blind spots; brief via `phase-graph.sh --qa-prompt N`).
  It reviews the real diff per `references/qa-method.md`, runs/extends tests, writes
  `docs/handoffs/<slug>/reports/phase-NN-qa.md`, and records the result via `scripts/qa-record.sh` into
  `docs/handoffs/<slug>/test-status.md` (`## QA status`: pass | fail | pending | waived). The closeout
  dispatches a `qa-full` subagent for the whole plan.
- Once `test-status.md` exists — on any plan, old or new — the engine **gates dependents on verification**:
  a dependent is `ready` only when every dependency is `done` **and** QA `pass`/`waived`. A `fail` holds
  all dependents until a re-QA passes — always commit + push the report + test-status.md so the gate
  propagates to every clone. Turning QA off by default never clears an existing `fail` row.
- On first mid-plan activation, `new-handoff.sh` backfills already-complete phases as `waived`
  (pre-activation) so gating doesn't retroactively block their dependents. Use `waived` only for a
  genuinely non-applicable check or a recorded plan-level waiver.

## Docs layout & repo split
- **Work-state lives in the project repo** under `docs/` (its `.gitignore` tracks only `/docs/`):
  `plans/<slug>.md` and `handoffs/<slug>/{INDEX.md, phase-NN-*.md, reports/phase-NN-qa.md, test-status.md,
  .locks/phase-NN.lock}`. Commit + push so any account/machine can pull and continue.
- **The skill lives in its own install** — a plugin, or a clone under `~/.claude*/skills/`. If you keep
  several clones, edit one and **commit → push → pull** in the others so all stay byte-identical. Never put
  work-state in the skill folder, or skill code in the project repo.

## Multi-repo commit atomicity (F11)
- A phase touching several repos makes one commit per repo — there's no cross-repo transaction. Guard
  against half-committed phases: do the commits **last** (after the work is verified), in a fixed repo
  order; if one fails, `git reset` the repos already committed for that phase before retrying, and never
  write the handoff until `git log -1` in each repo confirms the expected sha.
