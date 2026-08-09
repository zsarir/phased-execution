---
slug: mcp
created: 2026-08-09
status: active
phases: 4
handoffs: docs/handoffs/mcp/
memory: project_mcp
---

# MCP-directive test plan

Carries a `## Session budget` with an `MCP servers (every session):` line and a
mix of per-phase `- **MCP:**` bullets, so the engine must union the two, dedupe
them, and re-inject the result into every boot prompt + the QA brief.

Phase 4 deliberately names nothing: a plan with a plan-wide line still gives its
bare phases that line, and nothing more.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~1M working set/session  ·  **Branch:** current branch (no new branch)
**Skills (every session):** `design-system`
**MCP servers (every session):** `context7`

The budget prose below is the F15/parse regression: a loose `mcp` match would
swallow these backticked tokens into the server list. Sizing for `claude-opus-5`
follows the `mcp v1` note in `references/sizing.md`.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Adds one | — | 2 | r | x |
| 2 | Repeats the plan's | — | 1 | r | x |
| 3 | Adds two | 1, 2 | — | r | x |
| 4 | Names none | 3 | — | r | x |

## Phases

### Phase 1 — Adds one
- **Size:** S
- **MCP:** `github`
- **Verification:**
  - `true`

### Phase 2 — Repeats the plan's
- **Size:** S
- **MCP:** `context7`
- **Verification:**
  - `true`

### Phase 3 — Adds two
- **Size:** S
- **MCP:** `playwright`, `sentry`
- **Verification:**
  - `true`

### Phase 4 — Names none
- **Size:** S
- **Verification:**
  - `true`
