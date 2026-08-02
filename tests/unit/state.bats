#!/usr/bin/env bats
# Phase state classification from handoff status + the done-set (done|in-progress|
# stuck|ready|waiting). Locks in correct CURRENT behavior.
load ../helpers/test_helper

@test "fresh plan: only dependency-free phases are ready" {
  setup_docs diamond diamond
  run pg diamond --ready
  [ "$output" = "1" ]
}

@test "linear: completing phase 1 makes phase 2 ready" {
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  run pg linear --ready
  [ "$output" = "2" ]
}

@test "diamond: completing root makes 2 and 3 both ready (concurrency)" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run pg diamond --ready
  [ "$output" = "2 3" ]
}

@test "diamond: 4 becomes ready only when BOTH 2 and 3 are done" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_handoff diamond 2 left complete
  run pg diamond --ready
  [ "$output" = "3" ]           # 4 still waits on 3
  write_handoff diamond 3 right complete
  run pg diamond --ready
  [ "$output" = "4" ]
}

@test "outoforder: done {1,4} -> ready {2,3,5}, nothing falsely done" {
  setup_docs outoforder outoforder
  write_handoff outoforder 1 base complete
  write_handoff outoforder 4 mid complete
  run pg outoforder --ready
  [ "$output" = "2 3 5" ]
}

@test "in-progress handoff is not ready and blocks dependents" {
  setup_docs linear linear
  write_handoff linear 1 alpha in-progress
  run pg linear --ready
  [ "$output" = "" ]
  run pg linear
  assert_contains "$output" "in-progress"
}

@test "blocked handoff classifies as stuck on the board" {
  setup_docs linear linear
  write_handoff linear 1 alpha blocked
  run pg linear
  assert_contains "$output" "stuck"
}

@test "--ready-after N treats N as done without a handoff" {
  setup_docs diamond diamond
  run pg diamond --ready-after 1
  [ "$output" = "2 3" ]
}
