#!/usr/bin/env bats
# --qa-mode (v3): QA subagents are opt-in. Resolution order:
# canonical "**QA gate:** off" → waived · canonical on → on · legacy waiver
# prose → waived · test-status.md exists → on · else off. The canonical grep is
# line-anchored + bold-exact so real legacy waiver lines can never read as "on".
load ../helpers/test_helper

add_budget_line() {  # add_budget_line <slug> <line...>
  local slug="$1"; shift
  printf '\n## Session budget\n%s\n' "$*" >> "$DOCS_ROOT/docs/plans/$slug.md"
}

@test "qa-mode: off by default (no directive, no test-status.md)" {
  setup_docs diamond diamond
  run pg diamond --qa-mode
  [ "$output" = "off" ]
}

@test "qa-mode: canonical '**QA gate:** on' directive turns it on" {
  setup_docs diamond diamond
  add_budget_line diamond '**QA gate:** on'
  run pg diamond --qa-mode
  assert_contains "$output" "on (plan directive"
}

@test "qa-mode: canonical '**QA gate:** off' reads as waived" {
  setup_docs diamond diamond
  add_budget_line diamond '**QA gate:** off'
  run pg diamond --qa-mode
  assert_contains "$output" "waived (plan directive"
}

@test "qa-mode: journey-style legacy waiver prose reads as waived, never on" {
  setup_docs diamond diamond
  add_budget_line diamond '**QA gate: WAIVED for ALL phases** (user decision 2026-07-05) — at phase-finish do not dispatch the fresh-context QA subagent.'
  run pg diamond --qa-mode
  assert_contains "$output" "waived"
  refute_contains "$output" "on ("
}

@test "qa-mode: aws-cost-style blockquoted waiver prose reads as waived" {
  setup_docs diamond diamond
  add_budget_line diamond '> **QA gate: WAIVED for phases 2–9 by user directive.**'
  run pg diamond --qa-mode
  assert_contains "$output" "waived"
}

@test "qa-mode: an existing test-status.md turns QA on (back-compat)" {
  setup_docs diamond diamond
  printf '## QA status\n\n| Phase | Result |\n|--:|--|\n| 1 | pass |\n' \
    > "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  run pg diamond --qa-mode
  assert_contains "$output" "on (test-status.md exists)"
}

@test "qa-mode: a plan waiver beats an existing test-status.md (record waived, never dispatch)" {
  setup_docs diamond diamond
  add_budget_line diamond '**QA gate: WAIVED for phases 2–9 by user directive.**'
  printf '## QA status\n\n| Phase | Result |\n|--:|--|\n| 1 | pass |\n' \
    > "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  run pg diamond --qa-mode
  assert_contains "$output" "waived"
}

@test "qa-mode: unrelated 'on' words in §Session budget do not false-positive" {
  setup_docs diamond diamond
  add_budget_line diamond 'Target model: opus, committing on the main branch'
  run pg diamond --qa-mode
  [ "$output" = "off" ]
}

@test "new-handoff under a waived plan records the row as waived (no pending)" {
  setup_docs diamond diamond
  add_budget_line diamond '**QA gate:** off'
  run pe_newho diamond 1 root complete
  [ "$status" -eq 0 ]
  grep -qE '^\|[[:space:]]*1[[:space:]]*\|[[:space:]]*waived' "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  run pg diamond --ready
  [ "$output" = "2 3" ]                    # waived counts as verified — no stall
}

@test "mid-plan QA activation backfills earlier complete phases as waived" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete    # phase 1 finished before QA existed
  run pe_newho diamond 2 left complete --qa
  [ "$status" -eq 0 ]
  assert_contains "$output" "backfilled phase 1"
  grep -qE '^\|[[:space:]]*1[[:space:]]*\|[[:space:]]*waived' "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  grep -qE '^\|[[:space:]]*2[[:space:]]*\|[[:space:]]*pending' "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  # phase 1 stays verified (waived), so its OTHER dependent (3) is still ready;
  # 4 waits on 2's pending QA.
  run pg diamond --ready
  [ "$output" = "3" ]
}
