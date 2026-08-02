#!/usr/bin/env bats
# Engine-level diagnostics on the board + a --lint mode (F1/F2/F3).
# The board must surface structural problems by name instead of silently
# deadlocking or skipping rows. RED until phase-graph.sh is hardened.
#
# Negative fixtures are staged under NEUTRAL slugs (badrow/missingdep/loop) so an
# asserted keyword can't match the slug the board echoes in its header.
load ../helpers/test_helper

@test "board: undefined dependency is flagged as 'undefined' (not just 'needs: 9')" {
  setup_docs bad-undefined-dep missingdep
  run pg missingdep
  assert_contains "$output" "undefined"
}

@test "board: a cycle is named, not the generic 'nothing ready'" {
  setup_docs bad-cycle loop
  run pg loop
  assert_contains "$output" "cycle"
}

@test "board: a malformed phase row is surfaced by its bad cell (2a)" {
  setup_docs bad-malformed-table badrow
  run pg badrow
  assert_contains "$output" "2a"
}

@test "--lint: clean plan exits 0" {
  setup_docs linear linear
  run pg linear --lint
  [ "$status" -eq 0 ]
}

@test "--lint: cycle exits non-zero and names the cycle" {
  setup_docs bad-cycle loop
  run pg loop --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "cycle"
}

@test "--lint: undefined dep exits non-zero and names the phase" {
  setup_docs bad-undefined-dep missingdep
  run pg missingdep --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "undefined"
}

@test "--lint: malformed cell exits non-zero and names it" {
  setup_docs bad-malformed-table badrow
  run pg badrow --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" "2a"
}

@test "--lint: clean diamond and ranges pass" {
  setup_docs diamond diamond; run pg diamond --lint; [ "$status" -eq 0 ]
  setup_docs ranges ranges;   run pg ranges --lint;  [ "$status" -eq 0 ]
}
