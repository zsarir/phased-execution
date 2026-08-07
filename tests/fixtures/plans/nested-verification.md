---
slug: nested-verification
created: 2026-08-07
status: active
phases: 3
handoffs: docs/handoffs/nested-verification/
memory: project_nested-verification
---

# Nested verification test plan

Mirrors the shape a real hub plan was written in: every phase's §Verification
holds its commands as 2-space nested sub-bullets with `**Verify in:**` nested
among them. The JS parser must keep the whole list (a run once parked on
"the plan states no verification" over exactly this shape), and the F14 lint
advisory must stay silent — these phases DO carry runnable verification.
Phase 3 is the negative control: no Verification bullet at all, so F14 warns.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Backend  | —  | 2 | api-server | green |
| 2 | Admin    | —  | 1 | web-app    | green |
| 3 | Bare     | 1, 2 | — | all      | shipped |

**Blocking:** {1, 2} → 3.
**Independent:** 1 ∥ 2 (disjoint scopes).

## Phases

### Phase 1 — Backend
- **Goal:** stamped-basis billing.
- **Size:** S
- **Files to create/modify:**
  - **Migration** (one file): the columns
  - `api/routes.py`: the reserve
- **Exit criteria:**
  1. Charges once.
- **Verification:**
  - **Verify in:** api-server
  - `task audit:schema`
  - `pytest -q`
- **Handoff must record:** the shapes as shipped.

### Phase 2 — Admin
- **Goal:** the guide drawer.
- **Size:** S
- **Exit criteria:**
  1. Sections registered.
- **Verification:**
  - **Verify in:** web-app
  - `npm test`

### Phase 3 — Bare
- **Goal:** ship it — deliberately no verification bullet (F14's specimen).
- **Size:** S
- **Exit criteria:** 1. shipped

## End-to-end verification

`true`
