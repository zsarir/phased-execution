---
slug: qa-per-phase
created: 2026-08-22
status: active
phases: 5
handoffs: docs/handoffs/qa-per-phase/
memory: project_qa-per-phase
---

# Per-phase QA test plan

The plan gates on QA; individual phases opt out (or opt in) with a `- **QA:**`
bullet. Phase 1 inherits the plan; 2 turns QA off for itself; 3 says `on`
explicitly (which is the same as inheriting here, and is what carves a phase
back IN when the plan says off); 4 depends on 2; 5 depends on 3.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Inherits  | —  | — | r | builds |
| 2 | QA off    | —  | — | r | builds |
| 3 | QA on     | —  | — | r | builds |
| 4 | After off | 2  | — | r | builds |
| 5 | After on  | 3  | — | r | builds |

## Session budget

**QA gate:** on

## Phases

### Phase 1 — Inherits
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — QA off
- **Size:** S
- **QA:** off
- **Verification:**
  - `true`

### Phase 3 — QA on
- **Size:** S
- **QA:** on
- **Verification:**
  - `true`

### Phase 4 — After off
- **Size:** S
- **Verification:**
  - `true`

### Phase 5 — After on
- **Size:** S
- **Verification:**
  - `true`
