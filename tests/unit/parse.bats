#!/usr/bin/env bats
# Phase-graph table parsing: dependency grammar (ranges, commas, dashes, bold).
# These lock in correct CURRENT behavior — they must stay green through the refactor.
load ../helpers/test_helper

@test "linear: deps are parsed in chain order" {
  setup_docs linear linear
  run pg linear --deps 2; [ "$output" = "1" ]
  run pg linear --deps 3; [ "$output" = "2" ]
  run pg linear --deps 1; [ "$output" = "" ]
}

@test "diamond: comma list yields both parents" {
  setup_docs diamond diamond
  run pg diamond --deps 4
  [ "$status" -eq 0 ]
  [ "$output" = "2 3" ]
}

@test "diamond: dependents of root are 2 and 3" {
  setup_docs diamond diamond
  run pg diamond --dependents 1
  [ "$output" = "2 3" ]
}

@test "ranges: en-dash range 1–2 expands to 1 2" {
  setup_docs ranges ranges
  run pg ranges --deps 3
  [ "$output" = "1 2" ]
}

@test "ranges: comma list 1, 2, 3 parses" {
  setup_docs ranges ranges
  run pg ranges --deps 4
  [ "$output" = "1 2 3" ]
}

@test "ranges: em-dash range 2—4 expands to 2 3 4" {
  setup_docs ranges ranges
  run pg ranges --deps 5
  [ "$output" = "2 3 4" ]
}

@test "ranges: combo 1–2 (+4) expands to 1 2 4" {
  setup_docs ranges ranges
  run pg ranges --deps 6
  [ "$output" = "1 2 4" ]
}

@test "ranges: markdown-bold phase cell (**5**) is still parsed as phase 5" {
  setup_docs ranges ranges
  # If **5** were skipped, --dependents 4 would not include 5 (5 depends on 2-4).
  run pg ranges --dependents 4
  assert_contains "$output" "5"
}
