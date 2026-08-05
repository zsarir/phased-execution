---
slug: closed
created: 2026-01-01
status: abandoned         # active | complete | abandoned | superseded
phases: 3
handoffs: docs/handoffs/closed/
memory: project_closed
closed: 2026-01-02
closed_reason: shelved before phase 2 finished
---

# Closed test plan

The same 1 → 2 → 3 chain as `linear`, but closed while unfinished. Everything about
the graph is valid — closure is a decision about whether anyone still cares, not a
statement about whether the plan parses.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | repoA | package builds |
| 2 | Beta  | 1 | — | repoA | unit tests pass |
| 3 | Gamma | 2 | — | repoA | deploy succeeds |
