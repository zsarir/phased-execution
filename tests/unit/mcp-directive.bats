#!/usr/bin/env bats
# The MCP directives — the plan-wide `MCP servers (every session):` line in
# §Session budget and the per-phase `- **MCP:**` bullet. Both are re-injected
# into every boot prompt and the QA brief, and both answer `--mcp`, which is
# what the console's preflight reads before it spends a token on a phase.
#
# The union is the contract: a phase runs with the plan's servers PLUS its own,
# deduped. A plan with neither must emit nothing extra and must not fail under
# `set -euo pipefail` (the no-match grep trap that bit the skills directive).
load ../helpers/test_helper

@test "--mcp: with no phase, the plan-wide line alone" {
  setup_docs mcp mcp
  run pg mcp --mcp
  [ "$status" -eq 0 ]
  [ "$output" = "context7" ]
}

@test "--mcp N: a phase's own bullet is unioned with the plan's line" {
  setup_docs mcp mcp
  run pg mcp --mcp 1
  [ "$status" -eq 0 ]
  [ "$output" = "context7, github" ]
}

@test "--mcp N: a phase repeating the plan's server is not listed twice" {
  setup_docs mcp mcp
  run pg mcp --mcp 2
  [ "$status" -eq 0 ]
  [ "$output" = "context7" ]
}

@test "--mcp N: a phase naming several servers keeps them all, in order" {
  setup_docs mcp mcp
  run pg mcp --mcp 3
  [ "$status" -eq 0 ]
  [ "$output" = "context7, playwright, sentry" ]
}

@test "--mcp N: a phase with no bullet still gets the plan's line" {
  setup_docs mcp mcp
  run pg mcp --mcp 4
  [ "$status" -eq 0 ]
  [ "$output" = "context7" ]
}

@test "--mcp: a plan naming no servers answers empty and exits 0" {
  setup_docs linear linear
  run pg linear --mcp
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  run pg linear --mcp 2
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "boot-prompt: the phase's full server set is injected" {
  setup_docs mcp mcp
  run pg mcp --boot-prompt 3
  [ "$status" -eq 0 ]
  assert_contains "$output" "needs these MCP servers: context7, playwright, sentry"
  assert_contains "$output" "STOP and ask the operator to sign it in"
}

@test "qa-prompt: the QA brief is told what the phase ran with" {
  setup_docs mcp mcp
  run pg mcp --qa-prompt 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "ran with these MCP servers: context7, github"
}

@test "boot-prompt: a plan with NO MCP directive emits no MCP line and still succeeds" {
  setup_docs linear linear
  run pg linear --boot-prompt 2
  [ "$status" -eq 0 ]
  refute_contains "$output" "MCP servers"
}

@test "budget prose containing 'mcp' + backticks is NOT read as an MCP directive" {
  # The same regression that bit the skills directive: only the exact
  # "MCP servers (every session):" phrase may match, or a §Session budget note
  # like "sizing follows the `mcp v1` note" gets injected as a server to connect.
  setup_docs mcp mcp
  run pg mcp --mcp
  [ "$status" -eq 0 ]
  refute_contains "$output" "mcp v1"
  refute_contains "$output" "claude-opus-5"
  refute_contains "$output" "references/sizing.md"
}

@test "session-plan: attached servers add weight to the phases that carry them" {
  # mcp.md is four S phases (15K each). Without a surcharge all four would batch
  # into one 60K session at the default budget; the servers are what splits them.
  setup_docs mcp mcp
  run pg mcp --session-plan
  [ "$status" -eq 0 ]
  assert_contains "$output" "Session 1"
  assert_contains "$output" "Session 2"
}
