#!/usr/bin/env bats
# Session budgets + batching. Budget VALUES must stay stable through F5 (single
# source) — only their storage location changes, not the numbers.
# v3 budgets: weight ≈ 0.2 × effective window (1M-class → 200K, Haiku/default → 40K).
load ../helpers/test_helper

@test "session-plan: opus budget is ~200K" {
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "~200K"
}

@test "session-plan: haiku budget is ~40K" {
  setup_docs sizes sizes
  run pg sizes --session-plan haiku
  assert_contains "$output" "~40K"
}

@test "session-plan: unknown/no model defaults to ~40K" {
  setup_docs sizes sizes
  run pg sizes --session-plan
  assert_contains "$output" "~40K"
}

@test "session-plan: a small sequential chain batches into ONE opus session" {
  # sizes fixture sums to 175K (S+S+M+L+S) vs the 200K opus budget — if the
  # budget or the weights change, revisit this fixture's margin deliberately.
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "Session 1"
  refute_contains "$output" "Session 2"
}

@test "size weights: S=15K M=40K L=90K appear in the legend" {
  setup_docs sizes sizes
  run pg sizes --session-plan opus
  assert_contains "$output" "S=15K M=40K L=90K"
}
