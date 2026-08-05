#!/usr/bin/env bats
# Plan closure — the stored operator decision.
#
# Progress is computed from the handoffs and never stored. "Does anyone still care?"
# cannot be computed at all, so it lives in the plan's own `status:`. These tests pin
# the consequence: a terminal status quiets the plan everywhere without hiding it,
# and `--reopen` puts everything back.

load ../helpers/test_helper

setup() { export PE_TODAY=2026-01-02; }

# --- the predicate ------------------------------------------------------------

@test "an open plan reads as open" {
  setup_docs linear demo
  run pg demo --plan-status
  [ "$status" -eq 0 ]; [ "$output" = "active" ]
  run pg demo --closed
  [ "$status" -eq 1 ]
  assert_contains "$output" "open active"
}

@test "a plan with no status: line reads as active, not closed" {
  setup_docs linear demo
  grep -v '^status:' "$DOCS_ROOT/docs/plans/demo.md" > "$DOCS_ROOT/t" && mv "$DOCS_ROOT/t" "$DOCS_ROOT/docs/plans/demo.md"
  run pg demo --plan-status
  [ "$output" = "active" ]
  run pg demo --closed
  [ "$status" -eq 1 ]
}

@test "each terminal status reads as closed" {
  setup_docs closed demo
  for want in abandoned superseded complete; do
    pe_close demo --status "$want" --reason "why" >/dev/null
    run pg demo --plan-status
    [ "$output" = "$want" ] || { echo "expected $want, got $output" >&2; return 1; }
    run pg demo --closed
    [ "$status" -eq 0 ] || { echo "$want should read as closed" >&2; return 1; }
  done
}

@test "a trailing legend comment does not leak into the status" {
  setup_docs linear demo
  sed 's/^status: active/status: complete   # closed out earlier (was: active)/' \
    "$DOCS_ROOT/docs/plans/demo.md" > "$DOCS_ROOT/t" && mv "$DOCS_ROOT/t" "$DOCS_ROOT/docs/plans/demo.md"
  run pg demo --plan-status
  [ "$output" = "complete" ]
  run pg demo --closed
  [ "$status" -eq 0 ]
}

# --- the board ----------------------------------------------------------------

@test "the closed board banners, keeps every phase line, and offers no work" {
  setup_docs closed demo
  write_handoff demo 1 alpha complete
  write_handoff demo 2 beta blocked
  run pg demo
  [ "$status" -eq 0 ]
  assert_contains "$output" "🔒 CLOSED [abandoned]"
  assert_contains "$output" "shelved before phase 2 finished"
  assert_contains "$output" "--reopen"
  # closing quiets a plan; it never hides one
  assert_contains "$output" "Alpha"
  assert_contains "$output" "Beta"
  assert_contains "$output" "Gamma"
  # …but every call to action is gone
  assert_contains "$output" "No work is outstanding on a closed plan."
  refute_contains "$output" "READY NOW"
  refute_contains "$output" "WAITING:"
  refute_contains "$output" "SUGGESTED BATCHES"
  refute_contains "$output" "mark the plan complete"
}

@test "a QA fail is not shouted on a closed plan but is still recorded" {
  setup_docs closed demo
  write_handoff demo 1 alpha complete
  qa_record demo 1 fail --report r.md >/dev/null
  run pg demo
  refute_contains "$output" "QA:FAILED"
  # the row itself is untouched — closing suppresses reporting, not data
  run pg demo --qa-result 1
  [ "$output" = "fail" ]
}

@test "no phase is ready on a closed plan" {
  setup_docs closed demo
  run pg demo --ready
  [ "$status" -eq 0 ]; [ -z "$output" ]
  run pg demo --ready-after 1
  [ "$status" -eq 0 ]; [ -z "$output" ]
}

@test "the memory block records the closure" {
  setup_docs closed demo
  run pg demo --memory-block
  assert_contains "$output" "closed: abandoned 2026-01-02 — shelved before phase 2 finished"
}

@test "session planning has nothing to plan" {
  setup_docs closed demo
  run pg demo --session-plan
  [ "$status" -eq 0 ]
  assert_contains "$output" "No sessions to plan."
}

# --- gates --------------------------------------------------------------------

@test "lint reports a closed plan's problems but never gates on them" {
  setup_docs bad-undefined-dep demo
  run pg demo --lint
  [ "$status" -eq 1 ]
  pe_close demo --reason "not worth repairing" >/dev/null
  run pg demo --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK (closed)"
  assert_contains "$output" "noted, not gating"
}

@test "validate skips a closed plan instead of flunking it forever" {
  setup_docs closed demo
  write_handoff demo 1 alpha complete    # no boot section: fails F10 while open
  pe_close demo --reopen >/dev/null
  run pe_validate demo
  [ "$status" -eq 1 ]
  pe_close demo --reason "shelved" >/dev/null
  run pe_validate demo
  [ "$status" -eq 0 ]
  assert_contains "$output" "VALIDATE SKIPPED"
}

@test "a closed plan hands off to nobody" {
  setup_docs closed demo
  write_handoff demo 1 alpha complete
  run pe_nextp demo 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "is closed"
  refute_contains "$output" "START COPY"
}

@test "new-handoff refuses a closed plan unless forced" {
  setup_docs closed demo
  run pe_newho demo 2 beta
  [ "$status" -eq 2 ]
  assert_contains "$output" "refusing"
  assert_contains "$output" "--reopen"
  run pe_newho demo 2 beta complete --force
  [ "$status" -eq 0 ]
}

@test "a closed plan's leftover lock stops blocking other plans" {
  setup_docs closed demo
  cp "$PE_DIR/tests/fixtures/plans/linear.md" "$DOCS_ROOT/docs/plans/other.md"
  mkdir -p "$DOCS_ROOT/docs/handoffs/demo/.locks"
  printf 'slug=demo\nphase=2\nowner=ghost/x\nhost=h\nclaimed_at=1\nlease_until=99999999999\n' \
    > "$DOCS_ROOT/docs/handoffs/demo/.locks/phase-02.lock"

  run pe_lock other conflicts 1 --scope repoA --owner me/s
  [ "$status" -eq 0 ]
  assert_contains "$output" "no scope conflicts"

  # reopening restores the collision — closure is the only reason it was ignored
  pe_close demo --reopen >/dev/null
  run pe_lock other conflicts 1 --scope repoA --owner me/s
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT demo phase 2"
}

# --- the verb -----------------------------------------------------------------

@test "close-plan writes status, date and reason into the frontmatter" {
  setup_docs linear demo
  run pe_close demo --reason "took a different route"
  [ "$status" -eq 0 ]
  assert_contains "$output" "closed: demo = abandoned (2026-01-02)"
  run cat "$DOCS_ROOT/docs/plans/demo.md"
  assert_contains "$output" "status: abandoned"
  assert_contains "$output" "closed: 2026-01-02"
  assert_contains "$output" "closed_reason: took a different route"
}

@test "close-plan is idempotent and reopen round-trips" {
  setup_docs linear demo
  pe_close demo --reason one >/dev/null
  pe_close demo --status superseded --reason two >/dev/null
  run cat "$DOCS_ROOT/docs/plans/demo.md"
  assert_contains "$output" "status: superseded"
  assert_contains "$output" "closed_reason: two"
  [ "$(grep -c '^closed:' "$DOCS_ROOT/docs/plans/demo.md")" -eq 1 ]
  [ "$(grep -c '^status:' "$DOCS_ROOT/docs/plans/demo.md")" -eq 1 ]

  pe_close demo --reopen >/dev/null
  run cat "$DOCS_ROOT/docs/plans/demo.md"
  assert_contains "$output" "status: active"
  refute_contains "$output" "closed:"
  refute_contains "$output" "closed_reason:"
}

@test "close-plan only edits the frontmatter block" {
  setup_docs linear demo
  printf '\nstatus: this line is prose, not frontmatter\n' >> "$DOCS_ROOT/docs/plans/demo.md"
  pe_close demo --reason x >/dev/null
  run cat "$DOCS_ROOT/docs/plans/demo.md"
  assert_contains "$output" "status: this line is prose, not frontmatter"
}

@test "close-plan refuses a reason-less close, a bad status, and reopen with extras" {
  setup_docs linear demo
  run pe_close demo
  [ "$status" -eq 2 ]; assert_contains "$output" "--reason"
  run pe_close demo --status finished --reason x
  [ "$status" -eq 2 ]; assert_contains "$output" "invalid status"
  run pe_close demo --status active --reason x
  [ "$status" -eq 2 ]; assert_contains "$output" "--reopen"
  run pe_close demo --reopen --reason x
  [ "$status" -eq 2 ]
  run pe_close demo --force            # --force is the deliberate way past the reason
  [ "$status" -eq 0 ]
}

@test "close-plan releases the plan's own locks so nothing inherits them" {
  setup_docs linear demo
  mkdir -p "$DOCS_ROOT/docs/handoffs/demo/.locks"
  printf 'slug=demo\nphase=1\nowner=x/y\n' > "$DOCS_ROOT/docs/handoffs/demo/.locks/phase-01.lock"
  run pe_close demo --reason done-with-it
  assert_contains "$output" "released 1 phase lock"
  [ ! -e "$DOCS_ROOT/docs/handoffs/demo/.locks/phase-01.lock" ]
}

@test "close-plan rejects an unknown plan and a file with no frontmatter" {
  setup_docs linear demo
  run pe_close nosuchplan --reason x
  [ "$status" -eq 2 ]; assert_contains "$output" "no such plan"
  printf '# just a heading\n' > "$DOCS_ROOT/docs/plans/bare.md"
  run pe_close bare --reason x
  [ "$status" -eq 2 ]; assert_contains "$output" "no frontmatter"
}
