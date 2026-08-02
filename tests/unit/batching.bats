#!/usr/bin/env bats
# v3 batching: fewest sessions that respect deps, gates, QA, and budget.
# Siblings and L phases batch; GATED phases and unmet deps cut; done phases are
# excluded (live-aware); over-budget solos are flagged.
load ../helpers/test_helper

write_plan() {  # write_plan <slug> <<EOF-content on stdin>
  cat > "$DOCS_ROOT/docs/plans/$1.md"
}

@test "batching: parallel-safe siblings + their join batch into one session" {
  setup_docs diamond diamond
  # diamond: 1 → (2 ∥ 3) → 4, no Size tags (all M = 160K total ≤ 200K opus budget)
  run pg diamond --session-plan opus
  assert_contains "$output" "1 → 2 → 3 → 4"
  refute_contains "$output" "Session 2"
}

@test "batching: a GATED phase is always its own session and is never joined" {
  setup_docs diamond gt
  write_plan gt <<'EOF'
---
slug: gt
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/gt/
memory: project_gt
---

# gated batching fixture

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |
| 3 | c | 2 | — | r | x |

### Phase 1 — a
- **Size:** S

### Phase 2 — b *(GATED)*
- **Size:** S
- **Gates (must clear first):** 48h bake elapsed

### Phase 3 — c
- **Size:** S
EOF
  run pg gt --session-plan opus
  refute_contains "$output" "1 → 2"
  refute_contains "$output" "2 → 3"
  assert_contains "$output" "GATED"
}

@test "batching: a phase listed before its own dependency gets a flagged solo (no inversion)" {
  setup_docs diamond ooo
  write_plan ooo <<'EOF'
---
slug: ooo
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/ooo/
memory: project_ooo
---

# out-of-order table fixture (phase 2 depends on the later-listed phase 3)

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 3 | — | r | x |
| 3 | c | 1 | — | r | x |

### Phase 1 — a
- **Size:** S

### Phase 2 — b
- **Size:** S

### Phase 3 — c
- **Size:** S
EOF
  run pg ooo --session-plan opus
  assert_contains "$output" "waiting on: 3"
  refute_contains "$output" "2 → 3"
  refute_contains "$output" "3 → 2"
}

@test "batching: with QA gating on, a dependent never shares a session with its dep" {
  setup_docs diamond diamond
  printf '# QA status — diamond\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n' \
    > "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  run pg diamond --session-plan opus
  refute_contains "$output" "1 → 2"       # 2 depends on 1 → 1's verdict must land first
  assert_contains "$output" "2 → 3"       # siblings (both dep only on 1) still share
  refute_contains "$output" "3 → 4"       # 4 depends on 2,3
}

@test "batching: an over-budget solo phase is flagged to split (Haiku + L)" {
  setup_docs sizes sizes
  run pg sizes --session-plan haiku
  assert_contains "$output" "over budget — split"
}

@test "batching: done phases are excluded and noted (live-aware suggestions)" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run pg diamond --session-plan opus
  assert_contains "$output" "already done, excluded: 1"
  assert_contains "$output" "2 → 3 → 4"
}
