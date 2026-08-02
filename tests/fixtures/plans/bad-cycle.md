---
slug: bad-cycle
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/bad-cycle/
memory: project_bad_cycle
---

# NEGATIVE fixture: dependency cycle

1 → 3 → 2 → 1 is a cycle. Today the board silently shows every phase as waiting
with the generic "nothing ready" message and never names the cycle. validate.sh
must detect and name the cycle; the board must say the graph is unsatisfiable.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | 3 | — | r | x |
| 2 | b | 1 | — | r | x |
| 3 | c | 2 | — | r | x |
