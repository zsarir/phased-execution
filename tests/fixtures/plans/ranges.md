---
slug: ranges
created: 2026-01-01
status: active
phases: 6
handoffs: docs/handoffs/ranges/
memory: project_ranges
---

# Range / dash / bold parsing test plan

Exercises the Depends-on grammar: en-dash range (1–2), comma list (1, 2, 3),
em-dash range (2—4), a "(+N)" combo, and a markdown-bold phase cell (**5**).

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | One   | —        | — | r | x |
| 2 | Two   | 1        | — | r | x |
| 3 | Three | 1–2      | — | r | x |
| 4 | Four  | 1, 2, 3  | — | r | x |
| **5** | Five | 2—4    | — | r | x |
| 6 | Six   | 1–2 (+4) | — | r | x |
