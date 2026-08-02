---
slug: gated
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/gated/
memory: project_gated
---

# Gated-phase test plan

Phase 2 is externally gated (prose gate) and also carries a machine-checkable
Gate-check line for the F12 feature.

## Phase graph

| Phase | Title       | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------------|-----------|--------------------|-------|---------------|
| 1 | Setup       | — | — | r | builds |
| 2 | Gated thing | 1 | — | r | vendor approves |
| 3 | After       | 2 | — | r | builds |

### Phase 1 — Setup
- **Size:** S

### Phase 2 — Gated thing *(GATED)*
- **Gates (must clear first):** external vendor approval received
- **Gate-check:** manual vendor-approval
- **Size:** M

### Phase 3 — After
- **Size:** L
