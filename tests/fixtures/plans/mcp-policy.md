---
slug: mcp-policy
created: 2026-08-11
status: active
phases: 4
handoffs: docs/handoffs/mcp-policy/
memory: project_mcp_policy
---

# MCP-policy test plan

Carries a plan-wide `**MCP policy:**` line and a mix of per-phase
`- **MCP policy:**` bullets, so the engine must let the phase's own answer
outrank the plan's, and must report *nothing* where neither says anything —
"the plan has no opinion" is a different fact from "the plan says continue", and
only the first lets the RUN's setting speak.

Phase 3 is the one that matters most: a plan-wide `require` with a phase saying
`continue` has to come out `continue`, or a plan could never carve out the one
phase that genuinely does not need its servers.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~1M working set/session  ·  **Branch:** current branch (no new branch)
**MCP servers (every session):** `context7`
**MCP policy:** require

The prose here is the coercion regression: only the exact word `require` may
stop a plan, so a sentence mentioning `required` or `Require` elsewhere in the
budget must not be read as a directive.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Inherits the plan's | — | 2 | r | x |
| 2 | Says require itself | — | 1 | r | x |
| 3 | Carves itself out | 1, 2 | — | r | x |
| 4 | Says something meaningless | 3 | — | r | x |

## Phases

### Phase 1 — Inherits the plan's
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — Says require itself
- **Size:** S
- **MCP policy:** require
- **Verification:**
  - `true`

### Phase 3 — Carves itself out
- **Size:** S
- **MCP:** `github`
- **MCP policy:** continue
- **Verification:**
  - `true`

### Phase 4 — Says something meaningless
- **Size:** S
- **MCP policy:** whenever
- **Verification:**
  - `true`
