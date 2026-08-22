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

# --- "**QA gate:** off" must actually RELEASE the gate ------------------------
# Gating is triggered by test-status.md existing, and `qa_mode` was never
# consulted — so a plan the operator explicitly turned QA off for kept every
# `fail` and `pending` row holding its dependents, with no way out but editing
# the table by hand. `off` now means off; the verdicts stay recorded and
# visible, they just stop being a wall.

qa_off_plan() {  # add "**QA gate:** off" to the fixture's §Session budget
  printf '\n## Session budget\n\n**QA gate:** off\n' >> "$DOCS_ROOT/docs/plans/$1.md"
}
write_qa_row() {  # write_qa_row <slug> <phase> <result>
  local f="$DOCS_ROOT/docs/handoffs/$1/test-status.md"
  mkdir -p "$(dirname "$f")"
  [ -f "$f" ] || printf '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n' > "$f"
  printf '| %s | %s | - |\n' "$2" "$3" >> "$f"
}

@test "QA off: a recorded fail no longer holds dependents" {
  setup_docs diamond diamond
  qa_off_plan diamond
  write_handoff diamond 1 root complete
  write_qa_row diamond 1 fail
  run pg diamond --ready
  [ "$output" = "2 3" ]
}

@test "QA off: a pending row no longer holds dependents" {
  setup_docs diamond diamond
  qa_off_plan diamond
  write_handoff diamond 1 root complete
  write_qa_row diamond 1 pending
  run pg diamond --ready
  [ "$output" = "2 3" ]
}

@test "QA off: the recorded verdict is still reported, just not gating" {
  setup_docs diamond diamond
  qa_off_plan diamond
  write_handoff diamond 1 root complete
  write_qa_row diamond 1 fail
  run pg diamond --qa-result 1
  [ "$output" = "fail" ]
}

@test "QA off: no F19 deadlock advisory — nothing is held" {
  setup_docs diamond diamond
  qa_off_plan diamond
  write_handoff diamond 1 root complete
  write_qa_row diamond 1 fail
  run pg diamond --lint
  refute_contains "$output" "F19"
}

@test "QA on: a fail still holds dependents (the off switch is opt-in)" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa_row diamond 1 fail
  run pg diamond --ready
  [ "$output" = "" ]
}

# --- the directive must survive being written as a bullet --------------------
# `qa_mode`'s canonical greps were anchored so tightly that a leading `-` list
# marker missed BOTH the off and the on rule — and execution then fell through
# to "test-status.md exists -> on". So an operator who wrote `- **QA gate:** off`
# got the OPPOSITE of what they wrote, silently. That trap got sharper the moment
# per-phase QA shipped as a bullet (`- **QA:** off`), because a bullet is now the
# natural thing to type.

@test "QA gate off is honoured when written as a list item" {
  setup_docs diamond diamond
  printf '\n## Session budget\n\n- **QA gate:** off\n' >> "$DOCS_ROOT/docs/plans/diamond.md"
  write_handoff diamond 1 root complete
  write_qa_row diamond 1 fail
  run pg diamond --qa-mode
  assert_contains "$output" "waived"
  run pg diamond --ready
  [ "$output" = "2 3" ]
}

@test "QA gate on is honoured when written as a list item" {
  setup_docs diamond diamond
  printf '\n## Session budget\n\n- **QA gate:** on\n' >> "$DOCS_ROOT/docs/plans/diamond.md"
  run pg diamond --qa-mode
  assert_contains "$output" "on"
  assert_contains "$output" "plan directive"
}

@test "a trailing note after the directive does not hide it" {
  setup_docs diamond diamond
  printf '\n## Session budget\n\n**QA gate:** off (the suites are the bar here)\n' >> "$DOCS_ROOT/docs/plans/diamond.md"
  run pg diamond --qa-mode
  assert_contains "$output" "waived"
}

@test "prose that merely mentions the words still does not flip the gate" {
  setup_docs diamond diamond
  printf '\n## Session budget\n\nWe considered whether to turn the QA gate on for this plan.\n' \
    >> "$DOCS_ROOT/docs/plans/diamond.md"
  write_qa_row diamond 1 pass
  run pg diamond --qa-mode
  # test-status.md exists, so legacy back-compat says on — but from the FILE,
  # not from prose being mistaken for a directive.
  assert_contains "$output" "test-status.md exists"
}
