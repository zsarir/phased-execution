#!/usr/bin/env bats
# Skills directive (the plan's "## Session budget" `Skills (every session):` line) is
# re-injected into EVERY phase boot prompt and the QA brief, so a cold-start session
# re-invokes the skills the user named at plan time. A plan with no such line must emit
# nothing extra — and must not fail under `set -euo pipefail` (the no-match grep trap).
load ../helpers/test_helper

@test "boot-prompt: a plan's Skills directive is injected into the phase boot prompt" {
  setup_docs skilled skilled
  run pg skilled --boot-prompt 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "invoke these skills"
  assert_contains "$output" "frontend-design"
  assert_contains "$output" "superpowers:test-driven-development"
}

@test "qa-prompt: the Skills directive is injected into the QA brief too" {
  setup_docs skilled skilled
  run pg skilled --qa-prompt 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "frontend-design"
}

@test "boot-prompt: a plan with NO Skills directive emits no skills line and still succeeds" {
  setup_docs linear linear
  run pg linear --boot-prompt 2
  [ "$status" -eq 0 ]
  refute_contains "$output" "invoke these skills"
}

@test "boot-prompt: budget prose containing 'skill' + backticks is NOT read as a Skills directive" {
  # Regression (found by v3 smoke evals): a §Session budget line like
  # "**Budget:** per skill sizing defaults · `claude-opus-4-8`" used to be swallowed
  # by the loose 'skill' grep, injecting the model id as a skill to invoke.
  setup_docs linear linear
  printf '\n## Session budget\n**Target model:** `claude-opus-4-8` · **Budget:** ~200K weight/session (skill v3 sizing) · **Branch:** current\n' \
    >> "$DOCS_ROOT/docs/plans/linear.md"
  run pg linear --boot-prompt 2
  [ "$status" -eq 0 ]
  refute_contains "$output" "invoke these skills"
  refute_contains "$output" "claude-opus-4-8"
}
