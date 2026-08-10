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

# F16 — a §Verification that waits on an external clock warns at lint time,
# never gates. F14 asks "is anything runnable?"; F16 asks "does what runs ever
# finish on its own?". The live incident: a phase whose verification WAS the
# deploy of a CI-built image (34-65 min build) passed F14, boarded, and the
# session died holding the wait.

@test "F16: a fenced 'gh run watch' and a bulleted 'task deploy' are named, exit stays 0" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F16 phase 2"
  assert_contains "$output" "gh run watch"
  assert_contains "$output" "F16 phase 3"
  assert_contains "$output" "task deploy"
}

@test "F16: a bounded verification stays silent" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [[ "$output" != *"F16 phase 1"* ]]
}

@test "F16: runnable-but-unbounded does not trip F14" {
  setup_docs unbounded-verification unb
  run pg unb --lint
  [[ "$output" != *"F14"* ]]
}

@test "F16: a done phase is not nagged about history" {
  setup_docs unbounded-verification unb
  write_handoff unb 2 watch complete
  write_handoff unb 3 deploy complete
  run pg unb --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F16"* ]]
}
