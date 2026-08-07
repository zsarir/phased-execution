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

@test "gate-kind: manual is human, ai is ai, machine types are auto, ungated is none" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-kind 5;  [ "$output" = "human" ]
  run pg gatecheck --gate-kind 10; [ "$output" = "ai" ]
  run pg gatecheck --gate-kind 2;  [ "$output" = "auto" ]
  run pg gatecheck --gate-kind 4;  [ "$output" = "auto" ]
  run pg gatecheck --gate-kind 9;  [ "$output" = "auto" ]
  run pg gatecheck --gate-kind 1;  [ "$output" = "none" ]
}

@test "gate-kind: a GATED heading with no Gate-check is human (fail-safe)" {
  setup_docs gated gated
  sed -i.bak '/Gate-check/d' "$DOCS_ROOT/docs/plans/gated.md"
  run pg gated --gate-kind 2
  [ "$output" = "human" ]
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
