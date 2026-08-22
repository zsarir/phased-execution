#!/usr/bin/env bats
# Per-phase QA control: `- **QA:** on|off` in a phase's own section.
#
# `**QA gate:** on|off` in §Session budget is the whole-plan switch. This is the
# per-phase one, and it resolves the way every other per-phase directive does —
# the phase's own word wins, silence inherits the plan. It exists because "QA
# this plan" is rarely the truth: a docs phase, a scaffold, a ship phase whose
# real check is the deploy, do not want a reviewer; the two phases that touch
# money do.
load ../helpers/test_helper

qa_row() {  # qa_row <slug> <phase> <result>
  local f="$DOCS_ROOT/docs/handoffs/$1/test-status.md"
  mkdir -p "$(dirname "$f")"
  [ -f "$f" ] || printf '# QA\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n' > "$f"
  printf '| %s | %s | - |\n' "$2" "$3" >> "$f"
}

# --- reading the directive ---------------------------------------------------

@test "--qa-mode <phase> reports the phase's own regime" {
  setup_docs qa-per-phase qa-per-phase
  run pg qa-per-phase --qa-mode 1
  assert_contains "$output" "on"        # inherits the plan
  run pg qa-per-phase --qa-mode 2
  assert_contains "$output" "off"       # its own directive
  run pg qa-per-phase --qa-mode 3
  assert_contains "$output" "on"
}

@test "--qa-mode <phase> names WHERE the answer came from" {
  setup_docs qa-per-phase qa-per-phase
  run pg qa-per-phase --qa-mode 2
  assert_contains "$output" "phase directive"
  run pg qa-per-phase --qa-mode 1
  assert_contains "$output" "plan directive"
}

@test "--qa-mode with no phase still reports the plan's regime" {
  setup_docs qa-per-phase qa-per-phase
  run pg qa-per-phase --qa-mode
  assert_contains "$output" "on"
  assert_contains "$output" "plan directive"
}

# --- what it actually does: gating -------------------------------------------

@test "a QA-off phase does not hold its dependents, even with no verdict" {
  setup_docs qa-per-phase qa-per-phase
  write_handoff qa-per-phase 2 qa-off complete
  qa_row qa-per-phase 2 pending
  run pg qa-per-phase --ready
  assert_contains "$output" "4"
}

@test "a QA-off phase does not hold its dependents even on a recorded fail" {
  setup_docs qa-per-phase qa-per-phase
  write_handoff qa-per-phase 2 qa-off complete
  qa_row qa-per-phase 2 fail
  run pg qa-per-phase --ready
  assert_contains "$output" "4"
}

@test "a QA-on phase still holds its dependents until it passes" {
  setup_docs qa-per-phase qa-per-phase
  write_handoff qa-per-phase 3 qa-on complete
  qa_row qa-per-phase 3 pending
  run pg qa-per-phase --ready
  refute_contains "$output" "5"
}

@test "a QA-on phase releases its dependents once it passes" {
  setup_docs qa-per-phase qa-per-phase
  write_handoff qa-per-phase 3 qa-on complete
  qa_row qa-per-phase 3 pass
  run pg qa-per-phase --ready
  assert_contains "$output" "5"
}

# --- the phase word wins in BOTH directions ----------------------------------

@test "a phase may opt IN while the plan says off" {
  setup_docs qa-per-phase qa-per-phase
  # Flip the plan to off; phase 3 still says on, so it still gates.
  sed -i.bak 's/^\*\*QA gate:\*\* on$/**QA gate:** off/' "$DOCS_ROOT/docs/plans/qa-per-phase.md"
  write_handoff qa-per-phase 3 qa-on complete
  qa_row qa-per-phase 3 fail
  run pg qa-per-phase --qa-mode 3
  assert_contains "$output" "on"
  run pg qa-per-phase --ready
  refute_contains "$output" "5"
}

@test "a plan-wide off still releases the phases that said nothing" {
  setup_docs qa-per-phase qa-per-phase
  sed -i.bak 's/^\*\*QA gate:\*\* on$/**QA gate:** off/' "$DOCS_ROOT/docs/plans/qa-per-phase.md"
  write_handoff qa-per-phase 2 qa-off complete
  qa_row qa-per-phase 2 fail
  run pg qa-per-phase --ready
  assert_contains "$output" "4"
}

# --- the board and the blockers say which phases are exempt ------------------

@test "board: a QA-off phase is not annotated as QA-verified or QA-failed" {
  setup_docs qa-per-phase qa-per-phase
  write_handoff qa-per-phase 2 qa-off complete
  qa_row qa-per-phase 2 fail
  run pg qa-per-phase
  # It reads plainly done: the verdict is recorded but does not govern here.
  refute_contains "$output" "QA:FAILED"
}

@test "memory-block: a QA-off dep never appears as a qa: blocker" {
  setup_docs qa-per-phase qa-per-phase
  write_handoff qa-per-phase 2 qa-off complete
  qa_row qa-per-phase 2 fail
  run pg qa-per-phase --memory-block
  refute_contains "$output" "4<-2"
}

@test "lint: a plan held only by QA-off phases raises no F19" {
  setup_docs qa-per-phase qa-per-phase
  write_handoff qa-per-phase 2 qa-off complete
  qa_row qa-per-phase 2 fail
  run pg qa-per-phase --lint
  refute_contains "$output" "F19"
}

# --- the boot prompt tells the session which regime it is under --------------

@test "boot-prompt: a QA-off phase is not asked for a verdict" {
  setup_docs qa-per-phase qa-per-phase
  run pg qa-per-phase --boot-prompt 2
  refute_contains "$output" "qa-record.sh"
}

@test "boot-prompt: a QA-on phase is asked for one, with its own number" {
  setup_docs qa-per-phase qa-per-phase
  run pg qa-per-phase --boot-prompt 3
  assert_contains "$output" "qa-record.sh qa-per-phase 3"
}

# --- malformed and absent directives are the plan's word, not a crash --------

@test "an unrecognised QA word inherits the plan rather than guessing" {
  setup_docs qa-per-phase qa-per-phase
  printf '\n### Phase 6 — Nonsense\n- **Size:** S\n- **QA:** maybe\n' \
    >> "$DOCS_ROOT/docs/plans/qa-per-phase.md"
  run pg qa-per-phase --qa-mode 6
  assert_contains "$output" "on"
  assert_contains "$output" "plan directive"
}

@test "a phase with no section at all inherits the plan" {
  setup_docs qa-per-phase qa-per-phase
  run pg qa-per-phase --qa-mode 99
  assert_contains "$output" "on"
}

@test "the QA bullet does not leak from a neighbouring phase" {
  setup_docs qa-per-phase qa-per-phase
  # Phase 2 says off; 1 and 4 sit either side of a directive-bearing phase.
  run pg qa-per-phase --qa-mode 1; assert_contains "$output" "on"
  run pg qa-per-phase --qa-mode 4; assert_contains "$output" "on"
}

# --- new-handoff must record the PHASE's regime, not the plan's --------------
# The row a finish writes is the phase's claim about itself. Asking the plan
# meant a phase that opted IN on a waived plan was recorded `waived` — a verdict
# nobody gave, on the one phase the operator singled out for review.

@test "new-handoff: a phase that opts IN on a waived plan gets pending, not waived" {
  setup_docs qa-per-phase qa-per-phase
  sed -i.bak 's/^\*\*QA gate:\*\* on$/**QA gate:** off/' "$DOCS_ROOT/docs/plans/qa-per-phase.md"
  run pe_newho qa-per-phase 3 qa-on complete
  [ "$status" -eq 0 ]
  run cat "$DOCS_ROOT/docs/handoffs/qa-per-phase/test-status.md"
  assert_contains "$output" "| 3 | pending |"
  refute_contains "$output" "| 3 | waived |"
}

@test "new-handoff: a phase that opts OUT on a gating plan gets waived, not pending" {
  setup_docs qa-per-phase qa-per-phase
  run pe_newho qa-per-phase 2 qa-off complete
  [ "$status" -eq 0 ]
  run cat "$DOCS_ROOT/docs/handoffs/qa-per-phase/test-status.md"
  assert_contains "$output" "| 2 | waived |"
}

@test "new-handoff: a silent phase still follows the plan" {
  setup_docs qa-per-phase qa-per-phase
  run pe_newho qa-per-phase 1 inherits complete
  run cat "$DOCS_ROOT/docs/handoffs/qa-per-phase/test-status.md"
  assert_contains "$output" "| 1 | pending |"
}
