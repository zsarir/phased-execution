#!/usr/bin/env bats
# validate.sh — the deterministic plan/handoff validator (F1/F2/F3/F10).
# RED until scripts/validate.sh exists. Content assertions guard against the
# "script missing => non-zero => false green" trap.
#
# NOTE: negative fixtures are staged under NEUTRAL slugs (badrow/missingdep/loop)
# so an asserted keyword ("undefined", "cycle") can't accidentally match the slug
# that the tool echoes back in headers/messages.
load ../helpers/test_helper

@test "validate: clean linear plan passes (exit 0)" {
  setup_docs linear linear
  run pe_validate linear
  [ "$status" -eq 0 ]
}

@test "validate: every clean fixture passes" {
  for fx in diamond ranges gated sizes outoforder; do
    setup_docs "$fx" "$fx"
    run pe_validate "$fx"
    [ "$status" -eq 0 ] || { echo "fixture $fx unexpectedly failed validate: $output"; return 1; }
  done
}

@test "validate: malformed Phase cell is rejected and named (F1)" {
  setup_docs bad-malformed-table badrow
  run pe_validate badrow
  [ "$status" -ne 0 ]
  assert_contains "$output" "2a"
}

@test "validate: undefined dependency is rejected and named (F2)" {
  setup_docs bad-undefined-dep missingdep
  run pe_validate missingdep
  [ "$status" -ne 0 ]
  assert_contains "$output" "undefined"
  assert_contains "$output" "9"
}

@test "validate: dependency cycle is detected and named (F3)" {
  setup_docs bad-cycle loop
  run pe_validate loop
  [ "$status" -ne 0 ]
  assert_contains "$output" "cycle"
}
