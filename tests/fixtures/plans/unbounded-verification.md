---
slug: unbounded-verification
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/unbounded-verification/
memory: project_unbounded-verification
---

# Unbounded verification test plan

F16 fixture: phase 1 verifies with bounded commands, phase 2 watches a CI run
inside a fence, phase 3 deploys via nested bullets. Every §Verification is
runnable (F14 must stay silent); F16 must name phases 2 and 3 only.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Build  | — | — | repoA | unit green |
| 2 | Watch  | 1 | — | repoA | ci green |
| 3 | Deploy | 2 | — | repoA | deployed |

### Phase 1 — Build

- **Verification:**
  - `npm test`

### Phase 2 — Watch

- **Verification:**
  ```
  gh run watch 12345
  ```

### Phase 3 — Deploy

- **Verification:**
  - **Verify in:** services/api
  - `task deploy && sleep 2`
