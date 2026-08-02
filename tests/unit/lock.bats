#!/usr/bin/env bats
# phase-lock.sh — cooperative phase claims with a lease (the concurrency guard).
# Contract: phase-lock.sh <slug> <claim|release|status|list> <N> [--owner X] [--lease SECS]
# Lock files live at docs/handoffs/<slug>/.locks/phase-NN.lock
# RED until scripts/phase-lock.sh exists.
load ../helpers/test_helper

@test "lock: claim creates the lock file under .locks/" {
  setup_docs linear linear
  run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
}

@test "lock: a second owner is refused and told who holds it" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -ne 0 ]
  assert_contains "$output" "sessionA"
}

@test "lock: same owner re-claim is idempotent (exit 0)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
}

@test "lock: release frees the lock for another owner" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  pe_lock linear release 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -eq 0 ]
}

@test "lock: an expired lease can be taken over" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA --lease 0
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -eq 0 ]
  assert_contains "$output" "takeover"
}

@test "lock: status names the current holder" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear status 1
  assert_contains "$output" "sessionA"
}

@test "lock: status of an unclaimed phase reports free" {
  setup_docs linear linear
  run pe_lock linear status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "free"
}
