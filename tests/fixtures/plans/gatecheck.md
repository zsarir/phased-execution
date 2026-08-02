---
slug: gatecheck
created: 2026-01-01
status: active
phases: 5
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

### Phase 1 — base
- **Size:** S

### Phase 2 — future *(GATED)*
- **Gate-check:** date 2099-01-01

### Phase 3 — past *(GATED)*
- **Gate-check:** date 2000-01-01

### Phase 4 — needs-one *(GATED)*
- **Gate-check:** phase 1

### Phase 5 — ops *(GATED)*
- **Gate-check:** manual ops sign-off before launch
