---
slug: diamond
created: 2026-01-01
status: active
phases: 4
handoffs: docs/handoffs/diamond/
memory: project_diamond
---

# Diamond test plan

Fan-out then fan-in: 1 unblocks {2,3}; 4 needs both. After 1 is done, 2 and 3
are both ready (concurrency); 4 waits on 2 and 3.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Root  | —    | —   | r | builds |
| 2 | Left  | 1    | 3   | r | builds |
| 3 | Right | 1    | 2   | r | builds |
| 4 | Merge | 2, 3 | —   | r | builds |
