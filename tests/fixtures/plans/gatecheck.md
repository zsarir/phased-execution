---
slug: gatecheck
created: 2026-01-01
status: active
phases: 10
handoffs: docs/handoffs/gatecheck/
memory: project_gatecheck
---

# Machine-checkable gates test plan (F12)

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | base      | — | — | r | x |
| 2 | future    | 1 | — | r | x |
| 3 | past      | 1 | — | r | x |
| 4 | needs-one | 1 | — | r | x |
| 5 | ops       | 1 | — | r | x |
| 6 | several   | 1 | — | r | x |
| 7 | duesoon   | 1 | — | r | x |
| 8 | overdue   | 1 | — | r | x |
| 9 | factcheck | 1 | — | r | x |
| 10 | aigate   | 1 | — | r | x |

### Phase 1 — base
- **Size:** S

### Phase 2 — future *(GATED)*
- **Gate-check:** date 2099-01-01

### Phase 3 — past *(GATED)*
- **Gate-check:** date 2000-01-01

### Phase 4 — needs-one *(GATED)*
- **Gate-check:** phase 1

### Phase 5 — ops *(GATED)*
- **Gates (must clear first):** ops signs the launch checklist
- **Gate-check:** manual ops sign-off before launch

### Phase 6 — several *(GATED)*
- **Gate-check:** phases 1,3

### Phase 7 — duesoon *(GATED)*
- **Gate-check:** deadline 2099-01-01

### Phase 8 — overdue *(GATED)*
- **Gate-check:** deadline 2000-01-01

### Phase 9 — factcheck *(GATED)*
- **Gate-check:** cmd true

### Phase 10 — aigate *(GATED)*
- **Gates (must clear first):**
  1. staging deployed from main
  2. migrations applied on staging
  3. smoke suite green on staging
  4. feature flag enabled for the pilot cohort
  5. error rate steady for one hour
  6. on-call acknowledged the window
  7. the seventh condition sits far beyond the old six-line window
- **Gate-check:** ai verify staging deploy and smoke suite
- **Size:** S
