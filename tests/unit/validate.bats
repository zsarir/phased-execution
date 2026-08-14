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

@test "F10: a handoff with NO depends_on line is judged, never a silent death" {
  # Under `set -eo pipefail` the missing line used to fail the grep pipeline
  # and kill the validator mid-loop: exit 1, no ✗, no summary — the silent-red
  # shape this script exists to prevent. Dep-less phase: absent line means [].
  setup_docs scoped scoped
  write_handoff scoped 1 root complete
  printf '\n## Start next phase(s)\nnothing.\n' >> "$DOCS_ROOT/docs/handoffs/scoped/phase-01-root.md"
  run pe_validate scoped
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE OK"
}

@test "F10: a missing depends_on on a phase WITH deps reports the disagreement out loud" {
  setup_docs scoped scoped
  write_handoff scoped 2 api complete
  printf '\n## Start next phase(s)\nnothing.\n' >> "$DOCS_ROOT/docs/handoffs/scoped/phase-02-api.md"
  run pe_validate scoped
  [ "$status" -eq 1 ]
  assert_contains "$output" "disagrees with plan graph"
  assert_contains "$output" "VALIDATE FAIL"
}

@test "G13: a closed plan's garbage handoff status warns but stays exit 0" {
  setup_docs closed closedp
  write_handoff closedp 1 pasted "complete + write the closeout handoff. Verify every step"
  run pe_validate closedp
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE SKIPPED"
  assert_contains "$output" "is not one of complete|in-progress|blocked|pending"
}

@test "G13: a closed plan with clean handoffs stays quiet" {
  setup_docs closed closedp
  write_handoff closedp 1 clean complete
  run pe_validate closedp
  [ "$status" -eq 0 ]
  [[ "$output" != *"is not one of"* ]]
}
