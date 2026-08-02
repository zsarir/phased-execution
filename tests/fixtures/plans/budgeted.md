---
slug: budgeted
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/budgeted/
memory: project_budgeted
---

# Budgeted test plan

Carries a `## Session budget` naming Opus so the board's batches must size to
the opus budget (~200K, F6), not the no-model default (~40K).

## Session budget
- Target model: Opus 4.8
- Per-session weight budget: ~200K
- Branch: main

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |
| 3 | c | 2 | — | r | x |

### Phase 1 — a
- **Size:** S

### Phase 2 — b
- **Size:** S

### Phase 3 — c
- **Size:** S
