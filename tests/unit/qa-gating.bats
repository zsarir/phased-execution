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

# --- the `blocked:` line: why the board is empty (A1/B3/B5) -------------------
# The runner reads ONLY --memory-block, so a QA verdict that empties the ready
# set was invisible to it: an empty `ready:` is "finished", "all in flight",
# "closed" and "deadlocked" collapsed into one silence.

@test "memory-block: no blocked line when nothing is waiting" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_handoff diamond 2 left complete
  write_handoff diamond 3 right complete
  write_handoff diamond 4 merge complete
  run pg diamond --memory-block
  refute_contains "$output" "blocked:"
}

@test "memory-block: blocked names the unmet dep and why it is unmet" {
  setup_docs diamond diamond
  run pg diamond --memory-block
  # Nothing done yet: 2,3 wait on 1 because it is not done; 4 waits on 2 and 3.
  assert_contains "$output" "blocked: 2<-1(not-done) 3<-1(not-done) 4<-2(not-done),3(not-done)"
}

@test "memory-block: a QA-failed dep is named as qa:fail, not merely missing" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 fail
  run pg diamond --memory-block
  assert_contains "$output" "blocked: 2<-1(qa:fail) 3<-1(qa:fail)"
}

@test "memory-block: a QA-pending dep is named as qa:pending" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 pending
  run pg diamond --memory-block
  assert_contains "$output" "blocked: 2<-1(qa:pending)"
}

@test "memory-block: a done+passed dep drops out of blocked entirely" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 pass
  run pg diamond --memory-block
  # 2 and 3 are ready now; only 4 still waits, on two not-done phases.
  assert_contains "$output" "blocked: 4<-2(not-done),3(not-done)"
  refute_contains "$output" "2<-1"
}

@test "board: a done-but-QA-held dep is annotated in the WAITING line" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 fail
  run pg diamond
  # `needs: 1` next to `✅ 1 done` reads as a contradiction; say why.
  assert_contains "$output" "1(QA)"
}

@test "lint: a plan that can never progress is flagged (F19)" {
  setup_docs diamond diamond
  write_handoff diamond 1 root complete
  write_qa diamond 1 fail
  run pg diamond --lint
  # WARNING tier: stderr, exit untouched — the F14/F15/F16 arm.
  [ "$status" -eq 0 ]
  assert_contains "$output" "F19"
  assert_contains "$output" "cannot progress"
}

@test "lint: a healthy plan raises no F19" {
  setup_docs diamond diamond
  run pg diamond --lint
  refute_contains "$output" "F19"
}

# --- --ready-after must not pretend the QA gate is already passed (B4) --------
# `_is_verified` short-circuited on the assume-done hook, so `--ready-after N`
# answered "what unblocks when N is done AND QA-passed" while its callers
# (next-phase-prompt.sh, new-handoff.sh) ask "what unblocks when N is done".
# Under QA-on those differ, and the difference is a boot prompt for a phase the
# board then refuses to start.

@test "--ready-after honours the QA gate: a pending verdict unblocks nothing" {
  setup_docs diamond diamond
  write_qa diamond 1 pending
  run pg diamond --ready-after 1
  [ "$output" = "" ]
}

@test "--ready-after with QA gating off still assumes N is done" {
  setup_docs diamond diamond
  run pg diamond --ready-after 1
  [ "$output" = "2 3" ]
}

@test "--ready-after with a passed verdict unblocks dependents" {
  setup_docs diamond diamond
  write_qa diamond 1 pass
  run pg diamond --ready-after 1
  [ "$output" = "2 3" ]
}

# --- the boot prompt must name the finish-time QA duty (B2) -------------------
# SKILL.md tells a QA-on plan's finishing session to dispatch a QA subagent and
# record the verdict. The boot prompt — the ONLY thing an unattended session is
# told — never mentioned it. So `new-handoff.sh` wrote `pending`, nothing ever
# replaced it, and the phase's whole downstream cone was held with no defect
# recorded anywhere.

@test "boot-prompt: QA on names the verdict duty and the command" {
  setup_docs diamond diamond
  write_qa diamond 1 pass
  run pg diamond --boot-prompt 2
  assert_contains "$output" "qa-record.sh"
  assert_contains "$output" "holds every dependent"
}

@test "boot-prompt: QA off says nothing about QA" {
  setup_docs diamond diamond
  run pg diamond --boot-prompt 1
  refute_contains "$output" "qa-record.sh"
}

@test "boot-prompt: a waived plan does not ask for a verdict" {
  setup_docs diamond diamond
  write_qa diamond 1 pass
  printf '\n## Session budget\n\n**QA gate:** off\n' >> "$DOCS_ROOT/docs/plans/diamond.md"
  run pg diamond --boot-prompt 2
  refute_contains "$output" "qa-record.sh"
}
