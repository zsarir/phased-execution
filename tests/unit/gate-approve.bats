#!/usr/bin/env bats
# gate-approve.sh + the engine's approval short-circuit: an approved row in
# docs/handoffs/<slug>/gate-status.md clears --gate-status for EVERY gate kind
# (human, ai, auto — the operator's override, like a QA waiver); revoke restores
# the gate; and the sidecar must never flip QA gating on (it is deliberately a
# different file from test-status.md). Also pins the category-aware boot prompt.
load ../helpers/test_helper

@test "gate-approve: records an approval and the manual gate clears" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 5
  [ "$status" -ne 0 ]
  PE_TODAY=2026-01-03 run gate_approve gatecheck 5 --by tester --note "did the steps"
  [ "$status" -eq 0 ]
  assert_contains "$output" "approved: gatecheck phase 5 by tester on 2026-01-03"
  [ -f "$DOCS_ROOT/docs/handoffs/gatecheck/gate-status.md" ]
  run pg gatecheck --gate-status 5
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear (approved by tester on 2026-01-03)"
}

@test "gate-approve: clears ai and auto gates too (operator override)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 10
  [ "$status" -ne 0 ]
  assert_contains "$output" "ai:"
  PE_TODAY=2026-01-03 run gate_approve gatecheck 10 --by op
  run pg gatecheck --gate-status 10
  [ "$status" -eq 0 ]
  assert_contains "$output" "approved by op"
  PE_TODAY=2026-01-03 run gate_approve gatecheck 2 --by op --note "window waived"
  run pg gatecheck --gate-status 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "approved by op"
}

@test "gate-approve: an OVERDUE deadline clears once approved" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 8
  [ "$status" -ne 0 ]
  assert_contains "$output" "OVERDUE"
  PE_TODAY=2026-01-03 run gate_approve gatecheck 8 --by op
  run pg gatecheck --gate-status 8
  [ "$status" -eq 0 ]
}

@test "gate-approve: revoke restores the gate" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve gatecheck 5 --by tester
  run pg gatecheck --gate-status 5
  [ "$status" -eq 0 ]
  PE_TODAY=2026-01-04 run gate_approve gatecheck 5 --revoke --by tester
  assert_contains "$output" "revoked: gatecheck phase 5"
  run pg gatecheck --gate-status 5
  [ "$status" -ne 0 ]
  assert_contains "$output" "manual"
}

@test "gate-approve: upsert is idempotent — one row per phase, last write wins" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve gatecheck 5 --by first
  PE_TODAY=2026-01-04 run gate_approve gatecheck 5 --by second
  n="$(grep -c '^| 5 |' "$DOCS_ROOT/docs/handoffs/gatecheck/gate-status.md")"
  [ "$n" -eq 1 ]
  run pg gatecheck --gate-status 5
  assert_contains "$output" "approved by second on 2026-01-04"
}

@test "gate-approve: the sidecar never flips QA gating on" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve gatecheck 5 --by tester
  run pg gatecheck --qa-mode
  [ "$output" = "off" ]
}

@test "gate-approve: an approved but ungated phase still answers clear (no gate)" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve gatecheck 1 --by tester
  run pg gatecheck --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear (no gate)"
}

@test "gate-approve: the board shows kind and approval" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve gatecheck 5 --by tester
  run pg gatecheck
  assert_contains "$output" "GATED·human ✓approved"
  assert_contains "$output" "GATED·ai"
  assert_contains "$output" "GATED·auto"
}

@test "boot-prompt: an ai gate carries the FULL multi-line conditions and the clearance command" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 10
  [ "$status" -eq 0 ]
  assert_contains "$output" "GATED phase (ai-clearable)"
  assert_contains "$output" "seventh condition"
  assert_contains "$output" "gate-approve.sh gatecheck 10"
  assert_contains "$output" "commit + push"
}

@test "boot-prompt: a human gate says STOP and points at the console Gate card" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 5
  assert_contains "$output" "GATED phase (human)"
  assert_contains "$output" "Gate card"
  assert_contains "$output" "Do NOT implement"
}

@test "boot-prompt: an approved gate says proceed" {
  setup_docs gatecheck gatecheck
  PE_TODAY=2026-01-03 run gate_approve gatecheck 5 --by tester
  run pg gatecheck --boot-prompt 5
  assert_contains "$output" "already approved by tester"
  refute_contains "$output" "Do NOT implement"
}

@test "boot-prompt: an auto gate surfaces the live verdict without executing cmd gates" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --boot-prompt 2
  assert_contains "$output" "GATED phase (auto-checked)"
  assert_contains "$output" "blocked: opens on 2099-01-01"
  # a cmd gate's boot prompt must NEVER execute the command, even if the caller
  # exported the opt-in — the prompt is generated on page views too
  PHASE_EXEC_GATES=1 run pg gatecheck --boot-prompt 9
  assert_contains "$output" "cmd gate not executed"
}
