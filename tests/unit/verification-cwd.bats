#!/usr/bin/env bats
# F18 — a cwd-sensitive §Verification lead with no **Verify in:** warns at
# lint time, never gates. The runner executes §Verification at the repository
# root; `pnpm test` authored two directories deep exits 128/127 there and
# halts a run whose work was green. A `cd `-prefixed command settles the
# question itself; a declared **Verify in:** (top-level or nested under the
# Verification bullet) settles it for the whole phase.
load ../helpers/test_helper

@test "F18: a cwd-sensitive lead with no Verify in is named, exit stays 0" {
  setup_docs missing-lead ml
  run pg ml --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" 'F18 phase 4: `pnpm` is cwd-sensitive'
}

@test "F18: a declared Verify in silences the phase (nested counts)" {
  setup_docs missing-lead ml
  run pg ml --lint
  [[ "$output" != *"F18 phase 1"* ]]
  [[ "$output" != *"F18 phase 5"* ]]
}

@test "F18: a cd prefix settles the question" {
  setup_docs missing-lead ml
  run pg ml --lint
  [[ "$output" != *"F18 phase 6"* ]]
}

@test "F18: a done phase is not nagged about history" {
  setup_docs missing-lead ml
  write_handoff ml 4 root complete
  run pg ml --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F18"* ]]
}

@test "F18: validate.sh inherits the advisory without failing" {
  setup_docs missing-lead ml
  run pe_validate ml
  [ "$status" -eq 0 ]
  assert_contains "$output" "F18 phase 4"
  assert_contains "$output" "VALIDATE OK"
}
