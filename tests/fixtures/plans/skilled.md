---
slug: skilled
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/skilled/
memory: project_skilled
---

# Skills-directive test plan

Carries a `## Session budget` with a `Skills (every session):` line, so the engine
must re-inject those skills into every boot prompt + the QA brief.

## Session budget
**Target model:** `claude-opus-4-8`  ·  **Budget:** ~1M working set/session  ·  **Branch:** current branch (no new branch)
**Skills (every session):** `frontend-design`, `superpowers:test-driven-development`

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |

### Phase 1 — a
- **Size:** S

### Phase 2 — b
- **Size:** S
