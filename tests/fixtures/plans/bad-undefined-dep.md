---
slug: bad-undefined-dep
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/bad-undefined-dep/
memory: project_bad_undefined_dep
---

# NEGATIVE fixture: dependency on a non-existent phase

Phase 3 declares "Depends on: 9", but there is no phase 9. Today this makes
phase 3 wait forever (board shows "needs: 9") with no signal that 9 is invalid.
validate.sh must flag this; the board must mark it as an undefined dependency.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |
| 3 | c | 9 | — | r | x |
