#!/usr/bin/env bats
# F10 handoff body + consistency validation, and F8 --force repair.
load ../helpers/test_helper

setup() {
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans"
  cp "$PE_DIR/tests/fixtures/plans/diamond.md" "$DOCS_ROOT/docs/plans/demo.md"
}

@test "validate: a well-formed generated handoff (non-trivial deps) passes" {
  pe_newho demo 4 merge complete >/dev/null      # phase 4 depends on [2,3]
  run pe_validate demo
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE OK"
}

@test "validate: a handoff whose depends_on disagrees with the graph is rejected (F10)" {
  pe_newho demo 4 merge complete >/dev/null
  sed -i.bak 's/^depends_on:.*/depends_on: [1]/' "$DOCS_ROOT/docs/handoffs/demo/phase-04-merge.md"
  run pe_validate demo
  [ "$status" -ne 0 ]
  assert_contains "$output" "depends_on"
}

@test "validate: a handoff missing the boot section is rejected (F10)" {
  pe_newho demo 1 root complete >/dev/null
  sed -i.bak '/Start next phase/d' "$DOCS_ROOT/docs/handoffs/demo/phase-01-root.md"
  run pe_validate demo
  [ "$status" -ne 0 ]
  assert_contains "$output" "boot section"
}

@test "validate: a well-formed handoff with organic section names passes (not over-strict)" {
  pe_newho demo 1 root complete >/dev/null
  # rename the template's prose sections to organic ones; keep the boot section
  sed -i.bak 's/## What this phase did/## Done + verified on prod/; s/## Files changed/## Touched files/' \
    "$DOCS_ROOT/docs/handoffs/demo/phase-01-root.md"
  run pe_validate demo
  [ "$status" -eq 0 ]
}

@test "validate: an invalid handoff status is rejected (F10)" {
  pe_newho demo 1 root complete >/dev/null
  sed -i.bak 's/^status:.*/status: finished/' "$DOCS_ROOT/docs/handoffs/demo/phase-01-root.md"
  run pe_validate demo
  [ "$status" -ne 0 ]
  assert_contains "$output" "status"
}

@test "new-handoff --force repairs an existing handoff (F8)" {
  pe_newho demo 1 root complete >/dev/null
  run pe_newho demo 1 root complete --force
  [ "$status" -eq 0 ]
  assert_contains "$output" "overwriting"
}
