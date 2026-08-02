---
plan: docs/plans/{{SLUG}}.md
phase: {{PHASE}}
title: {{TITLE}}
status: {{STATUS}}            # complete | in-progress | blocked | pending
completed: {{DATE}}
next_phase: {{NEXT_PHASE}}    # linear hint only; the live ready-set is computed by scripts/phase-graph.sh
depends_on: [{{DEPENDS_ON}}]  # phases that had to finish before this one (from the plan graph)
blocks: [{{BLOCKS}}]          # phases that list this one as a dependency (auto-filled from the graph)
parallel_safe: []             # phases safe to run in a SEPARATE session at the same time as this
skills_used: []               # skills invoked this phase
key_files: []                 # repo-relative or absolute paths touched
memory: {{MEMORY_KEY}}
---

# Phase {{PHASE}} → next handoff: {{TITLE}}

## What this phase did
<!-- 1–3 sentences + bullets of what shipped. -->

## State now (verified)
<!-- tests X/Y green; committed (shas); deployed? migration applied? prisma republished?
     ⚠️  Verify against git log / git status BEFORE writing — never copy shas from memory.
     The environment may auto-commit (hooks); confirm the actual sha/message. Be honest. -->

## Files changed
<!-- paths grouped by repo -->

## Key decisions / gotchas
<!-- why-this-way notes the next session must not relitigate -->

## ▶ Start next phase(s) (paste into fresh sessions)

<!-- AUTO-FILLED by scripts/new-handoff.sh from the plan's phase graph: one fenced
     boot prompt per phase that THIS phase unblocks (there may be several — run ONE
     session at a time; the finishing session may batch straight into one of them
     while the budget lasts — or none if downstream still waits on other deps).
     Re-generate anytime with:
       scripts/next-phase-prompt.sh {{SLUG}} {{PHASE}}
     and check live state with:
       scripts/phase-graph.sh {{SLUG}} -->
{{NEXT_PROMPTS}}

## Outstanding / blockers
<!-- anything unresolved; "none" if clean -->
