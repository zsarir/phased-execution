---
slug: sizes
created: 2026-01-01
status: active
phases: 5
handoffs: docs/handoffs/sizes/
memory: project_sizes
---

# Sizing / batching test plan

A sequential chain with mixed Size tags (phase 3 intentionally omits one to test
the default-to-M behavior). Drives --size and --session-plan batching.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |
| 3 | c | 2 | — | r | x |
| 4 | d | 3 | — | r | x |
| 5 | e | 4 | — | r | x |

### Phase 1 — a
- **Size:** S

### Phase 2 — b
- **Size:** S

### Phase 4 — d
- **Size:** L

### Phase 5 — e
- **Size:** S
