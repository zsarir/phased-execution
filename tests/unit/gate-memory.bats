#!/usr/bin/env bats
# F12 machine-checkable gates (--gate-status) + F9 memory-block generator.
load ../helpers/test_helper

@test "gate-status: a future date gate is blocked (exit 1)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 2
  [ "$status" -ne 0 ]
  assert_contains "$output" "blocked"
}

@test "gate-status: a past date gate is clear (exit 0)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 3
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
}

@test "gate-status: a phase gate is blocked until that phase is verified" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 4
  [ "$status" -ne 0 ]                     # phase 1 not done yet
  write_handoff gatecheck 1 base complete
  run pg gatecheck --gate-status 4
  [ "$status" -eq 0 ]                     # phase 1 done (no QA gating) -> verified -> clear
  assert_contains "$output" "clear"
}

@test "gate-status: a manual gate needs human confirmation (exit 1)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 5
  [ "$status" -ne 0 ]
  assert_contains "$output" "manual"
}

@test "gate-status: a phase with no gate-check is clear and not spilled from a neighbour" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
  refute_contains "$output" "2099"        # must NOT pick up phase 2's gate-check
}

@test "memory-block: emits done / ready / waiting sets in canonical form" {
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  run pg linear --memory-block
  [ "$status" -eq 0 ]
  assert_contains "$output" "done: 1"
  assert_contains "$output" "ready: 2"
  assert_contains "$output" "waiting: 3"
}

@test "memory-block: a diamond after root shows two ready" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run pg diamond --memory-block
  assert_contains "$output" "ready: 2, 3"
}
