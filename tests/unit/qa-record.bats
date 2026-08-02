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
