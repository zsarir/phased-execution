#!/usr/bin/env bats
# `**MCP policy:**` — what a phase does when one of its MCP servers will not
# connect. Two shapes: a plan-wide line in §Session budget and a per-phase
# `- **MCP policy:**` bullet, answered by `--mcp-policy [N]`.
#
# Three properties, and every one of them is load-bearing somewhere:
#
#  - the PHASE outranks the plan, which is the opposite of how `--mcp` composes
#    (servers union; policies override) — a plan can need three servers where
#    only one phase genuinely cannot proceed without them;
#  - only the exact word `require` counts, so a typo can never stop a plan;
#  - silence prints NOTHING rather than `continue`. "The plan has no opinion" is
#    a different fact from "the plan says continue", and only the first lets the
#    run's own setting answer. Collapsing them would make a run-level choice
#    unreachable on every plan ever written.
load ../helpers/test_helper

@test "--mcp-policy: with no phase, the plan-wide line alone" {
  setup_docs mcp-policy mcp-policy
  run pg mcp-policy --mcp-policy
  [ "$status" -eq 0 ]
  [ "$output" = "require" ]
}

@test "--mcp-policy N: a phase with no bullet inherits the plan's line" {
  setup_docs mcp-policy mcp-policy
  run pg mcp-policy --mcp-policy 1
  [ "$status" -eq 0 ]
  [ "$output" = "require" ]
}

@test "--mcp-policy N: a phase restating the plan's answer is still that answer" {
  setup_docs mcp-policy mcp-policy
  run pg mcp-policy --mcp-policy 2
  [ "$status" -eq 0 ]
  [ "$output" = "require" ]
}

@test "--mcp-policy N: a phase may carve itself out of a plan-wide require" {
  # The whole reason the phase bullet exists, and the reason `continue` has to
  # be a word the parser recognises rather than merely the absence of `require`.
  # Without this a plan could never say "these servers matter, except in the one
  # phase that touches none of it".
  setup_docs mcp-policy mcp-policy
  run pg mcp-policy --mcp-policy 3
  [ "$status" -eq 0 ]
  [ "$output" = "continue" ]
}

@test "--mcp-policy N: a word that is not 'require' reads as no directive at all" {
  # Phase 4 says `whenever`. It must not park anything, and it must not be
  # mistaken for a deliberate `continue` either — it falls back to the plan.
  setup_docs mcp-policy mcp-policy
  run pg mcp-policy --mcp-policy 4
  [ "$status" -eq 0 ]
  [ "$output" = "require" ]
}

@test "--mcp-policy: a plan that says nothing prints nothing, not 'continue'" {
  setup_docs mcp mcp
  run pg mcp --mcp-policy
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
  run pg mcp --mcp-policy 1
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "--mcp-policy: a plan with no §Session budget at all is not an error" {
  # The no-match-grep-under-pipefail trap that bit the skills directive.
  setup_docs linear linear
  run pg linear --mcp-policy
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
  run pg linear --mcp-policy 1
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "F15 names the consequence the policy actually produces" {
  # The warning used to promise "every phase will park at boarding" whatever the
  # plan said, which is now false for the default and true only under `require`.
  # A lint that describes behaviour the console does not have is worse than no
  # lint: an operator acts on it.
  setup_docs mcp mcp
  PE_MCP_SERVERS="context7" run pg mcp --lint
  [ "$status" -eq 0 ]
  [[ "$output" == *"run without them and report it"* ]]
  [[ "$output" != *"will park at boarding"* ]]

  setup_docs mcp-policy mcp-policy
  PE_MCP_SERVERS="" run pg mcp-policy --lint
  [ "$status" -eq 0 ]
  [[ "$output" == *"every phase will park at boarding"* ]]
}
