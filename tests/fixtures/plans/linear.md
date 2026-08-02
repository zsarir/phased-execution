---
slug: linear
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/linear/
memory: project_linear
---

# Linear test plan

A simple 1 → 2 → 3 chain. No gates, no size tags.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | repoA | package builds |
| 2 | Beta  | 1 | — | repoA | unit tests pass |
| 3 | Gamma | 2 | — | repoA | deploy succeeds |
