#!/usr/bin/env bats
# Gate detection + size resolution. Locks in correct CURRENT behavior.
load ../helpers/test_helper

@test "gated: phase 2 is gated, phase 1 is not" {
  setup_docs gated gated
  run pg gated --gated 2; [ "$output" = "yes" ]
  run pg gated --gated 1; [ "$output" = "no" ]
}

@test "gated: board marks the gated phase" {
  setup_docs gated gated
  run pg gated
  assert_contains "$output" "GATED"
}

@test "size: explicit S/M/L tags are read" {
  setup_docs gated gated
  run pg gated --size 1; [ "$output" = "S" ]
  run pg gated --size 2; [ "$output" = "M" ]
  run pg gated --size 3; [ "$output" = "L" ]
}

@test "size: missing tag defaults to M" {
  setup_docs sizes sizes
  run pg sizes --size 3
  [ "$output" = "M" ]
}
