#!/usr/bin/env bats
# F12 machine-checkable gates (--gate-status) + F9 memory-block generator.
load ../helpers/test_helper

@test "gate-status: a future date gate is blocked (exit 1)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 2
  [ "$status" -ne 0 ]
  assert_contains "$output" "blocked"
}

@test "gate-status: a past date gate is clear (exit 0)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 3
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
}

@test "gate-status: a phase gate is blocked until that phase is verified" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 4
  [ "$status" -ne 0 ]                     # phase 1 not done yet
  write_handoff gatecheck 1 base complete
  run pg gatecheck --gate-status 4
  [ "$status" -eq 0 ]                     # phase 1 done (no QA gating) -> verified -> clear
  assert_contains "$output" "clear"
}

@test "gate-status: a manual gate needs human confirmation (exit 1)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 5
  [ "$status" -ne 0 ]
  assert_contains "$output" "manual"
}

@test "gate-status: a phase with no gate-check is clear and not spilled from a neighbour" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
  refute_contains "$output" "2099"        # must NOT pick up phase 2's gate-check
}

@test "gate-status: a phases gate needs every listed phase verified" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 6
  [ "$status" -ne 0 ]
  assert_contains "$output" "blocked"
  write_handoff gatecheck 1 base complete
  run pg gatecheck --gate-status 6
  [ "$status" -ne 0 ]
  assert_contains "$output" "3"
  write_handoff gatecheck 3 past complete
  run pg gatecheck --gate-status 6
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear"
}

@test "gate-status: deadline before the date is clear, after is OVERDUE" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 7
  [ "$status" -eq 0 ]
  assert_contains "$output" "deadline"
  run pg gatecheck --gate-status 8
  [ "$status" -ne 0 ]
  assert_contains "$output" "OVERDUE"
}

@test "gate-status: a cmd gate does not execute unless opted in" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 9
  [ "$status" -ne 0 ]
  assert_contains "$output" "cmd gate not executed"
  PHASE_EXEC_GATES=1 run pg gatecheck --gate-status 9
  [ "$status" -eq 0 ]
  assert_contains "$output" "clear (cmd ok)"
}

@test "gate-status: a mutating cmd gate is refused even when opted in" {
  setup_docs gatecheck denyplan
  cat > "$DOCS_ROOT/docs/plans/denyplan.md" <<'EOF'
---
slug: denyplan
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/denyplan/
memory: project_denyplan
---
# deny
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |

### Phase 2 — b *(GATED)*
- **Gate-check:** cmd rm -rf /nowhere
EOF
  PHASE_EXEC_GATES=1 run pg denyplan --gate-status 2
  [ "$status" -ne 0 ]
  assert_contains "$output" "REFUSED"
}

@test "gate-status: a cross-plan gate clears when the other plan's phases are done" {
  setup_docs linear otherplan
  setup_docs gatecheck xp
  cat > "$DOCS_ROOT/docs/plans/xp.md" <<'EOF'
---
slug: xp
created: 2026-01-01
status: active
phases: 1
handoffs: docs/handoffs/xp/
memory: project_xp
---
# xp
## Phase graph
| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | waitother | — | — | r | x |

### Phase 1 — waitother *(GATED)*
- **Gate-check:** plan otherplan:1
EOF
  run pg xp --gate-status 1
  [ "$status" -ne 0 ]
  assert_contains "$output" "blocked"
  write_handoff otherplan 1 alpha complete
  run pg xp --gate-status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "otherplan"
}

@test "gate-status: an ai gate reports its instructions with kind ai (exit 1)" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --gate-status 10
  [ "$status" -ne 0 ]
  assert_contains "$output" "ai: verify staging deploy and smoke suite"
}

@test "gate-status: a multi-line prose gate is reported whole, not truncated at six lines" {
  setup_docs gatecheck fulltext
  # strip phase 10's Gate-check so the manual fallback surfaces the prose
  sed -i.bak '/ai verify staging deploy/d' "$DOCS_ROOT/docs/plans/fulltext.md"
  run pg fulltext --gate-status 10
  [ "$status" -ne 0 ]
  assert_contains "$output" "manual"
  assert_contains "$output" "seventh condition"
}

@test "lint: the gatecheck fixture (every gate type incl. ai) is clean" {
  setup_docs gatecheck gatecheck
  run pg gatecheck --lint
  [ "$status" -eq 0 ]
}

@test "lint: an unknown Gate-check type is reported by name" {
  setup_docs gatecheck typo
  sed -i.bak 's/manual ops sign-off before launch/manuel ops sign-off/' "$DOCS_ROOT/docs/plans/typo.md"
  run pg typo --lint
  [ "$status" -ne 0 ]
  assert_contains "$output" 'unknown Gate-check type "manuel"'
}

@test "memory-block: emits done / ready / waiting sets in canonical form" {
  setup_docs linear linear
  write_handoff linear 1 alpha complete
  run pg linear --memory-block
  [ "$status" -eq 0 ]
  assert_contains "$output" "done: 1"
  assert_contains "$output" "ready: 2"
  assert_contains "$output" "waiting: 3"
}

@test "memory-block: a diamond after root shows two ready" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run pg diamond --memory-block
  assert_contains "$output" "ready: 2, 3"
}
