#!/usr/bin/env bats
# End-to-end Mode 1→3 lifecycle. QA is OPT-IN since v3: by default new-handoff
# scaffolds only the handoff + INDEX (no test-status.md, no gating) and the
# closeout has no qa-full brief; --qa (or a plan directive / existing file)
# turns the QA machinery on.
load ../helpers/test_helper

setup() {
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans"
  cp "$PE_DIR/tests/fixtures/plans/diamond.md" "$DOCS_ROOT/docs/plans/demo.md"
}

@test "new-handoff scaffolds handoff + INDEX and NO test-status.md by default (QA opt-in)" {
  run pe_newho demo 1 root complete
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/demo/phase-01-root.md" ]
  [ -f "$DOCS_ROOT/docs/handoffs/demo/INDEX.md" ]
  [ ! -f "$DOCS_ROOT/docs/handoffs/demo/test-status.md" ]
}

@test "QA off: finishing a phase unblocks dependents immediately (no gating)" {
  pe_newho demo 1 root complete >/dev/null
  run pg demo --ready
  [ "$output" = "2 3" ]
}

@test "--qa flag forces QA on: test-status.md created with a pending row" {
  run pe_newho demo 1 root complete --qa
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/demo/test-status.md" ]
  grep -qE '^\|[[:space:]]*1[[:space:]]*\|[[:space:]]*pending' "$DOCS_ROOT/docs/handoffs/demo/test-status.md"
  run pg demo --ready
  [ "$output" = "" ]                       # 2,3 now gated on phase-1 QA
}

@test "QA on: dependents gated until the verdict is recorded pass" {
  pe_newho demo 1 root complete --qa >/dev/null
  printf '## QA status\n\n| Phase | Result |\n|--:|--|\n| 1 | pass |\n' \
    > "$DOCS_ROOT/docs/handoffs/demo/test-status.md"
  run pg demo --ready
  [ "$output" = "2 3" ]
}

@test "next-phase-prompt no longer emits a separate QA-skill prompt (QA is a subagent now)" {
  pe_newho demo 1 root complete >/dev/null
  run pe_nextp demo 1
  [ "$status" -eq 0 ]
  refute_contains "$output" "/phased-execution-qa"
  assert_contains "$output" "START COPY"
}

@test "--qa-prompt emits an independent fresh-context QA-subagent brief" {
  pe_newho demo 1 root complete >/dev/null
  run pg demo --qa-prompt 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "INDEPENDENT"
  assert_contains "$output" "qa-record.sh"
  refute_contains "$output" "/phased-execution-qa"
}

@test "closeout omits the qa-full brief for a QA-off plan (verification steps remain)" {
  run pe_nextp demo none
  [ "$status" -eq 0 ]
  refute_contains "$output" "qa-full demo"
  assert_contains "$output" "End-to-end verification"
}

@test "closeout emits the qa-full brief when the plan enables QA" {
  printf '\n## Session budget\n**QA gate:** on\n' >> "$DOCS_ROOT/docs/plans/demo.md"
  run pe_nextp demo none
  [ "$status" -eq 0 ]
  assert_contains "$output" "qa-full demo"
}

@test "new-handoff refuses to overwrite an existing handoff (no idempotent clobber)" {
  pe_newho demo 1 root complete >/dev/null
  run pe_newho demo 1 root complete
  [ "$status" -ne 0 ]
  assert_contains "$output" "refusing to overwrite"
}
