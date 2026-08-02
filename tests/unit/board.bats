#!/usr/bin/env bats
# Board rendering: F6 model-aware batch budget + the structure-problems block.
load ../helpers/test_helper

@test "board: batches reflect the plan's Session budget model (F6, opus -> ~200K)" {
  setup_docs budgeted budgeted
  run pg budgeted
  assert_contains "$output" "~200K"
}

@test "board: batches default to ~40K when no Session budget is declared" {
  setup_docs sizes sizes
  run pg sizes
  assert_contains "$output" "~40K"
}

@test "board: a clean plan shows no STRUCTURE PROBLEMS block" {
  setup_docs diamond diamond
  run pg diamond
  refute_contains "$output" "STRUCTURE PROBLEMS"
}

@test "board: a cycle plan shows the STRUCTURE PROBLEMS block" {
  setup_docs bad-cycle loop
  run pg loop
  assert_contains "$output" "STRUCTURE PROBLEMS"
}
