#!/usr/bin/env bats
# QA verification gating (Task 6): when test-status.md exists, dependents are
# gated on deps being QA-verified (pass|waived), not merely done.
load ../helpers/test_helper

qa_file() { echo "$DOCS_ROOT/docs/handoffs/$1/test-status.md"; }
write_qa() {  # write_qa <slug> <phase> <result>
  local f; f="$(qa_file "$1")"; mkdir -p "$(dirname "$f")"
  if [ ! -f "$f" ]; then printf '# QA status — %s\n\n## QA status\n\n| Phase | Result | Report |\n|--:|--|--|\n' "$1" > "$f"; fi
  printf '| %s | %s | - |\n' "$2" "$3" >> "$f"
}

@test "gating OFF by default: a done dep unblocks dependents (no test-status.md)" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  run pg diamond --ready
  [ "$output" = "2 3" ]
}

@test "gating ON: a done-but-pending dep does NOT unblock dependents" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 pending
  run pg diamond --ready
  [ "$output" = "" ]
}

@test "gating ON: a passed dep unblocks dependents" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 pass
  run pg diamond --ready
  [ "$output" = "2 3" ]
}

@test "gating ON: a failed dep blocks dependents" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 fail
  run pg diamond --ready
  [ "$output" = "" ]
}

@test "gating ON: waived counts as verified" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 waived
  run pg diamond --ready
  [ "$output" = "2 3" ]
}

@test "--qa-result reports the recorded result (or none)" {
  setup_docs diamond diamond
  write_qa diamond 1 pass
  write_qa diamond 2 fail
  run pg diamond --qa-result 1; [ "$output" = "pass" ]
  run pg diamond --qa-result 2; [ "$output" = "fail" ]
  run pg diamond --qa-result 3; [ "$output" = "none" ]
}

@test "board: a QA-verified phase is marked, dependents open up" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 pass
  run pg diamond
  assert_contains "$output" "verified"
  assert_contains "$output" "READY NOW:   2 3"
}

@test "board: a QA-failed phase is flagged and holds dependents" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 fail
  run pg diamond
  assert_contains "$output" "QA:FAILED"
}
