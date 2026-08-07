#!/usr/bin/env bats
# F14 — a phase without a runnable §Verification warns at lint time, never gates.
# The advisory exists because the autopilot parks such a phase at boarding
# ("nothing would prove the work"), hours after plan time; the author should
# hear it while the plan is still in front of them. Warning tier by design:
# exit codes and the LINT OK line never move.
load ../helpers/test_helper

@test "F14: an open phase with no Verification bullet is named, exit stays 0" {
  setup_docs nested-verification nestedv
  run pg nestedv --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F14 phase 3"
}

@test "F14: nested sub-bullet verification counts as runnable" {
  setup_docs nested-verification nestedv
  run pg nestedv --lint
  [[ "$output" != *"F14 phase 1"* ]]
  [[ "$output" != *"F14 phase 2"* ]]
}

@test "F14: a done phase is not nagged about history" {
  setup_docs nested-verification nestedv
  write_handoff nestedv 3 bare complete
  run pg nestedv --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F14"* ]]
}

@test "F14: a plan whose every phase verifies stays silent" {
  setup_docs scoped scoped
  run pg scoped --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F14"* ]]
}

@test "F14: validate.sh inherits the advisory without failing" {
  setup_docs nested-verification nestedv
  run pe_validate nestedv
  [ "$status" -eq 0 ]
  assert_contains "$output" "F14 phase 3"
  assert_contains "$output" "VALIDATE OK"
}

@test "F14: a closed plan is not scanned" {
  setup_docs closed closedp
  run pg closedp --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F14"* ]]
}
