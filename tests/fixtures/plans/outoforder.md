---
slug: outoforder
created: 2026-01-01
status: active
phases: 5
handoffs: docs/handoffs/outoforder/
memory: project_outoforder
---

# Out-of-order test plan

A deep chain 1 → 4 → 5 alongside siblings 2 and 3 (both depend only on 1).
Completing 1 and 4 (out of numeric order) must leave 5 ready while 2 and 3 are
still ready and nothing falsely reports "done".

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | base    | — | 2, 3 | r | x |
| 2 | sib-a   | 1 | 3    | r | x |
| 3 | sib-b   | 1 | 2    | r | x |
| 4 | mid     | 1 | 2, 3 | r | x |
| 5 | tip     | 4 | —    | r | x |
