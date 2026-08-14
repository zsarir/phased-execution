#!/usr/bin/env bats
# F17 — a §Verification lead that is not installed on this machine warns at
# lint time, never gates. Born from a measured incident class: 16 spurious
# verify-failed halts because `rg` was a shell function in the authoring
# session and `python` meant python3 — every one predicted by the runner's
# preflight hours after the author could have heard it. Warning tier by
# design: exit codes and the LINT OK line never move.
load ../helpers/test_helper

@test "F17: a missing lead is named with its env prefix stripped, exit stays 0" {
  setup_docs missing-lead ml
  run pg ml --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" 'F17 phase 2: §Verification lead `pe-definitely-absent-xyz`'
  assert_contains "$output" "will SKIP that command at verification"
}

@test "F17: an installed lead stays silent" {
  setup_docs missing-lead ml
  run pg ml --lint
  [[ "$output" != *"F17 phase 1"* ]]
}

@test "F17: backticked exit-code tables produce no lead and no warning" {
  setup_docs missing-lead ml
  run pg ml --lint
  [[ "$output" != *"F17 phase 3"* ]]
}

@test "F17: backticked numbers alone are not runnable — F14 names that phase" {
  setup_docs missing-lead ml
  run pg ml --lint
  assert_contains "$output" "F14 phase 3"
  [[ "$output" != *"F14 phase 2"* ]]
  [[ "$output" != *"F14 phase 1"* ]]
}

@test "F17: a done phase is not nagged about history" {
  setup_docs missing-lead ml
  write_handoff ml 2 missing complete
  run pg ml --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F17"* ]]
}

@test "F17: validate.sh inherits the advisory without failing" {
  setup_docs missing-lead ml
  run pe_validate ml
  [ "$status" -eq 0 ]
  assert_contains "$output" "F17 phase 2"
  assert_contains "$output" "VALIDATE OK"
}

@test "F17: a closed plan is not scanned" {
  setup_docs closed closedp
  run pg closedp --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F17"* ]]
}
