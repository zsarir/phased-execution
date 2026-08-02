---
slug: bad-malformed-table
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/bad-malformed-table/
memory: project_bad_malformed_table
---

# NEGATIVE fixture: malformed Phase cell

Phase row 2 has a non-integer Phase cell ("2a"). The current parser SILENTLY
skips it (parsing 2 rows, not 3); validate.sh must instead error clearly, and
the engine must not present a board that omits a declared phase without warning.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1  | a | — | — | r | x |
| 2a | b | 1 | — | r | x |
| 3  | c | 2 | — | r | x |
