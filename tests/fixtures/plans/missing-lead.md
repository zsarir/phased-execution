---
slug: missing-lead
created: 2026-01-01
status: active
phases: 6
handoffs: docs/handoffs/missing-lead/
memory: project_missing-lead
---

# Missing-lead / cwd fixture

F17+F18 fixture: phase 1 verifies with an installed lead (git) and pins a
Verify in; phase 2 names a binary that exists nowhere, behind an env prefix;
phase 3's only backticked content is an exit-code table (F14 must fire, F17
must stay silent); phase 4 runs pnpm with no Verify in (F18); phase 5 pins
Verify in (silent); phase 6 cd-prefixes the command (silent).

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Green    | — | — | repoA | checked |
| 2 | Missing  | 1 | — | repoA | checked |
| 3 | Table    | 2 | — | repoA | checked |
| 4 | Root     | 3 | — | repoA | checked |
| 5 | Pinned   | 4 | — | repoA | checked |
| 6 | Prefixed | 5 | — | repoA | checked |

### Phase 1 — Green

- **Verification:**
  - **Verify in:** repoA
  - `git status --porcelain`

### Phase 2 — Missing

- **Verification:**
  - `FOO=1 pe-definitely-absent-xyz --check all`
  - `git log --oneline -1`

### Phase 3 — Table

- **Verification:**
  - the exit codes seen in the wild were `1` and `128 112 3 12 124`

### Phase 4 — Root

- **Verification:**
  - `pnpm test`

### Phase 5 — Pinned

- **Verification:**
  - **Verify in:** services/api
  - `pnpm test`

### Phase 6 — Prefixed

- **Verification:**
  - `cd services/api && pnpm test`
