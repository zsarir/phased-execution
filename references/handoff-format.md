# Handoff format

Contents: Brevity principle · Frontmatter · Companion files · Body sections ·
Paste block format · Status source of truth · INDEX.md

A handoff is the **baton** a finishing phase hands to the next session. It must let a cold session — no
prior conversation — start the next phase. One handoff per phase, at `docs/handoffs/<slug>/phase-NN-<title>.md`,
plus a per-plan `INDEX.md`. Both are committed. Write one for **every** phase, even when you batch the
next phase into the same session — that's what keeps each phase independently resumable.

## Brevity principle
Self-contained but tight. Do **not** re-list the phase roadmap — link to `docs/plans/<slug>.md`. Put long
logs, full diffs, or large snippets in the files themselves (reference paths), not the handoff. Aim for a
reader to bootstrap in ~2 minutes.

## Handoff frontmatter (required)

```yaml
---
plan: docs/plans/<slug>.md
phase: <N>
title: <kebab-title>
status: complete            # complete | in-progress | blocked | pending
completed: <YYYY-MM-DD>
next_phase: <N+1 | none>    # linear hint only; the live ready-set comes from phase-graph.sh
depends_on: [<phases that had to finish before this one>]   # auto-filled from the plan graph
blocks: [<phases that list this one as a dependency>]        # auto-filled from the plan graph
parallel_safe: [<phases safe to run in a SEPARATE session at the same time as this>]
skills_used: [<skills actually invoked this phase — a descriptive record; distinct from the plan's prescriptive "Skills (every session)" directive>]
key_files:
  - <repo-relative or absolute path touched>
memory: project_<slug>      # or pre-existing project_<other> — see conventions.md
---
```

`new-handoff.sh` auto-fills `depends_on` (this phase's prerequisites) and `blocks` (phases that name this
one as a dependency) directly from the plan's Phase-graph table. They make each handoff self-describing in
a DAG: a reader of phase 5's handoff sees it depended on 4 and can verify 4 is `done` before building on it.

The frontmatter is machine-greppable, but **don't treat `status:` as a linear cursor** — the authoritative
"what's done / ready / waiting" is computed across all phases by `scripts/phase-graph.sh <slug>`, which
reads every handoff's `status:` and the plan graph together. `next_phase:` is only a hint; a completed
phase may unblock several phases or none.

**Status note:** `scripts/new-handoff.sh` accepts an optional fourth arg `[status]` (default `complete`).
Pass `in-progress` or `blocked` when scaffolding a handoff mid-phase. An `in-progress` handoff is also the
durable **pause marker**: a session interrupted mid-phase (usage limit, died console, deliberate stop) that
scaffolds one leaves the next session a bootstrap that says "continue from here, don't restart" — record
what is done, what is uncommitted, and (for a usage-limit stop) when the window reopens. The same marker
covers an **external wait** (a CI build, a PR auto-merge, a deploy window): write the `in-progress`
handoff *before* stopping, and — under a supervising runner — also declare the wait machine-readably with
`scripts/phase-outcome.sh <slug> <N> waiting-external …` so the autopilot parks and resumes the session
instead of reading the stop as a failure. A stop with **work still left** but nothing wrong (budget,
context) is the same marker plus `scripts/phase-outcome.sh <slug> <N> partial --reason
<budget|context|other>` — the autopilot reads it as work in progress and continues the session (or
boards a fresh one with a resume brief) by itself. The status vocabulary itself is unchanged
(`complete | in-progress | blocked | pending`): `waiting` is a **runner** phase state, never a handoff
status. `pending` / `TBD`
are valid in `INDEX.md` rows for phases not yet written (added by hand — the script only scaffolds phases
that exist). `INDEX.md` is an append log — per-handoff `status:` is the truth the board reads; a stale
INDEX row is cosmetic.
`new-handoff.sh` auto-detects the final phase by reading `phases:` from the plan and sets `next_phase: none`.
Pass `--force` to re-scaffold (repair) an existing handoff.

**Companion files.** The per-plan folder also holds, beside the handoffs: `.locks/phase-NN.lock` (the
active phase claim from `phase-lock.sh`) and — **only when QA is enabled for the plan** (`--qa-mode` ≠
off; QA is opt-in since v3) — `test-status.md` (per-phase QA results that gate dependents — written via
`qa-record.sh`, never by hand) and `reports/phase-NN-qa.md` (the QA report per phase). On a QA-`on` plan
`new-handoff.sh` scaffolds the `pending` row at phase-finish and the fresh QA subagent records the
verdict; on a `waived` plan the row is written as `waived` with no subagent; on the default (`off`)
neither file exists.

## Body sections (in order)

1. **`# Phase N → next handoff: <title>`**
2. **`## What this phase did`** — 1–3 sentences + bullets of what shipped.
3. **`## State now (verified)`** — tests X/Y green; committed (shas); deployed? migration applied?
   prisma republished? ⚠️ **Verify against `git log` / `git status` before writing — never copy commit
   shas from memory.** The environment may auto-commit (hooks); confirm the actual sha/message. If
   something is half-done, say so explicitly. Stale "uncommitted" claims are the top recurring defect.
4. **`## Files changed`** — paths grouped by repo.
5. **`## Key decisions / gotchas`** — why-this-way notes the next session must not relitigate. **Every
   ruling this phase recorded belongs here in words** (`phase-outcome.sh <slug> <N> ruling …` puts the
   same decision in the ledger the console reads; this section is what a *person* reads). The three
   shapes worth a line each: an instruction that admitted two readings and which one you took; a
   departure from what the plan said, and why; something in scope you deliberately left, and to whom.
6. **`## ▶ Start next phase(s) (paste into fresh sessions)`** — auto-generated by `scripts/new-handoff.sh`:
   **one plain-fenced boot prompt per phase that this phase unblocks** (often one; sometimes several, which
   may run as concurrent sessions when their scopes are disjoint; sometimes none, when downstream phases
   still wait on other deps). Gated phases are flagged. Review it, don't hand-rewrite it; re-generate with
   `scripts/next-phase-prompt.sh <slug> <N>`. **Keep the heading literal** — it's a stable grep + splice
   target. Final-phase handoffs get **`## 🏁 Final phase — closeout`** instead.
7. **`## Outstanding / blockers`** — anything unresolved, or "none".

**A ruling is not a status.** The frontmatter's `status:` vocabulary is frozen at
`complete | in-progress | blocked | pending`, and the outcome protocol's is frozen at
`complete | waiting-external | blocked | needs-human | partial`. A ruling says what a session
DECIDED, not how it ended: nothing acts on one, it never parks a phase, and declaring one is never
a substitute for declaring an outcome.

## Paste block format (section 6)

Each fenced boot prompt is copy-pasted verbatim into a fresh session. Per ready phase P:

    /phased-execution

    Continue the "<slug>" plan — start Phase P in this fresh session.
    [gate block — gated phases only, by category: an ai gate orders the session to verify each
     condition, do the work, record the clearance (gate-approve.sh) and continue; a human gate says
     STOP and points at the console's Gate card; an approved gate says proceed]
    Bootstrap from disk only:
    - docs/handoffs/<slug>/<P's dependency handoffs>
    - docs/plans/<slug>.md §Phase P + §Session budget (model, budget, branch)
    - memory <memory-key>
    This is a DAG: other phases may be ready and lower-numbered phases may still be unfinished — do NOT
    assume phases below P are done. Run scripts/phase-graph.sh <slug> for live state.

    This phase's SCOPE (the repos it touches, from the plan's Repos column): <csv>
    Two sessions may run at once ONLY on disjoint scopes. Before implementing:
      1. git pull, then: phase-lock.sh <slug> conflicts P --scope "<csv>" --git
         A reported conflict means STOP AND ASK the user.
      2. phase-lock.sh <slug> claim P --owner "<account>/<session>" --scope "<csv>" --git
    The invariant: never two live sessions whose scopes intersect; same repo ⇒ serialized;
    `all` ⇒ exclusive; disjoint ⇒ parallel. (Handoff/lock commits in the docs repo are NOT part of
    your scope — pull --rebase and retry up to 3 times if one races.)

    Then build the pP.task* list and implement Phase P to its exit criteria.

    When done, the deliverable is the HANDOFF — the board reads status: from it, and a
    phase with no handoff does not exist to the board. Scaffold it with:
        bash <scripts>/new-handoff.sh <slug> P <kebab-title> complete
    then fill in docs/handoffs/<slug>/phase-PP-<kebab-title>.md and commit it.
    Cannot finish? Hand off in-progress (paused, resumable) or blocked (needs help) —
    never end the session without a handoff. Stop after the handoff exists.

(4-space indent here avoids backtick nesting; the real handoff uses plain ` ``` ` fences.) The "Read first"
lines point at **P's dependency handoffs** — the phases P builds on — not merely the previous number.
`scripts/next-phase-prompt.sh` echoes the same per-phase blocks to the terminal at end of Mode 3, flanked
by START COPY / END COPY markers.

## Status source of truth

**Status is computed, not stored as a cursor.** `scripts/phase-graph.sh <slug>` reads every handoff's
`status:` frontmatter + the plan graph and classifies each phase `done | in-progress | ready | waiting` —
correct however phases are run, including concurrently and out of order. INDEX.md + per-handoff `status:` are the inputs it
aggregates; keep them accurate. The plan's Phase-graph "Exit criteria" column is the *definition* of done
(may carry a `✅ DONE` note) but is secondary. A plan is finished only when the board shows **all** phases
`done` — never when the highest number is reached.

**Whether to batch the next phase in-session is computed too**, from the plan's `## Session budget` +
`references/sizing.md` + the running model — not a handoff field. Write a handoff for **every** phase even
when you batch the next one into the same session: that's what keeps each phase independently resumable
from a cold session, which is the whole contract.

## INDEX.md (one per plan)

```markdown
# Handoffs — <slug>

Plan: [`docs/plans/<slug>.md`](../../plans/<slug>.md) · Memory: `<memory-key>`

| Phase | Title | Status | Handoff |
|------:|-------|--------|---------|
| 01 | schema | complete | [phase-01-schema.md](phase-01-schema.md) |
| 02 | api    | pending  | TBD |
```

`scripts/new-handoff.sh` creates the file from `templates/INDEX.md`, creates `INDEX.md` if missing, and
appends the phase row using the `[status]` arg. Add `pending` / `TBD` rows by hand for future phases.
