#!/usr/bin/env bats
# qa-record.sh writes test-status.md that the phased-execution engine reads back.
load ../helpers/test_helper

@test "qa-record creates test-status and records a pass the engine can read" {
  setup_docs diamond demo
  qa_record demo 1 pass --report reports/phase-01-qa.md
  [ -f "$DOCS_ROOT/docs/handoffs/demo/test-status.md" ]
  run pg demo --qa-result 1
  [ "$output" = "pass" ]
}

@test "qa-record upserts in place (no duplicate rows) when the result changes" {
  setup_docs diamond demo
  qa_record demo 1 pending
  qa_record demo 1 pass
  run pg demo --qa-result 1; [ "$output" = "pass" ]
  n=$(grep -cE '^\|[[:space:]]*1[[:space:]]*\|' "$DOCS_ROOT/docs/handoffs/demo/test-status.md")
  [ "$n" -eq 1 ]
}

@test "qa-record fail gates dependents; pass releases them (engine end-to-end)" {
  setup_docs diamond demo
  write_handoff demo 1 root complete
  qa_record demo 1 fail
  run pg demo --ready; [ "$output" = "" ]
  qa_record demo 1 pass
  run pg demo --ready; [ "$output" = "2 3" ]
}

@test "qa-record rejects an invalid result" {
  setup_docs diamond demo
  run qa_record demo 1 maybe
  [ "$status" -ne 0 ]
}

@test "qa-record records the report path in the table" {
  setup_docs diamond demo
  qa_record demo 2 pass --report reports/phase-02-qa.md
  grep -q 'reports/phase-02-qa.md' "$DOCS_ROOT/docs/handoffs/demo/test-status.md"
}

# --- creating test-status.md must not retroactively un-verify (B1) ------------
# `new-handoff.sh` backfills already-complete phases as `waived` when it creates
# the file; `qa-record.sh` did not — and `Service.activateQa` reaches THIS path.
# Turning QA on mid-plan therefore flipped every finished phase's dependents
# from ready back to waiting, with no verdict recorded anywhere.

@test "qa-record: creating the file backfills completed phases as waived" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run qa_record diamond 2 pending --report reports/phase-02-qa.md
  [ "$status" -eq 0 ]
  run cat "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  assert_contains "$output" "| 1 | waived |"
}

@test "qa-record: the backfill leaves the ready set where it was" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run pg diamond --ready
  [ "$output" = "2 3" ]
  qa_record diamond 2 pending --report reports/phase-02-qa.md
  run pg diamond --ready
  [ "$output" = "2 3" ]          # was "" before the backfill existed
}

@test "qa-record: an existing file is never re-backfilled" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  qa_record diamond 1 fail --report reports/phase-01-qa.md
  qa_record diamond 2 pending --report reports/phase-02-qa.md
  run cat "$DOCS_ROOT/docs/handoffs/diamond/test-status.md"
  assert_contains "$output" "| 1 | fail |"
  refute_contains "$output" "| 1 | waived |"
}
