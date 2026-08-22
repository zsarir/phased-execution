#!/usr/bin/env bats
# phase-outcome.sh — the machine-readable session outcome. Born from a live run:
# a phase-8 session that had done real work ended its turn "waiting on the image
# build (34-65 min)" in free prose, the runner read the clean exit as completion,
# found no handoff, and halted the run. The outcome file is the record the
# runner reads instead of guessing; these tests pin the exact JSON (the runner's
# parser and the journal both consume it verbatim).
load ../helpers/test_helper

setup() {
  export PE_NOW="2026-08-10T21:10:03Z"
  export PE_OUTCOME_FILE="$BATS_TEST_TMPDIR/outcome.json"
  # The ruling ledger the runner would inject. Append-only, unlike the outcome
  # file, which is written whole and consumed.
  export PE_RULINGS_FILE="$BATS_TEST_TMPDIR/rulings.ndjson"
  # The session line is written only when a session id is known; this suite
  # may itself run inside a Claude session that exports one.
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID
  # The unsupervised fallback writes into the console's state home for the
  # repository root — both pointed at the test's own directories.
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT"
}

# The identity rule of viewer/shared/instances.mjs, in bash: sha256(root)[:8]-basename.
inbox_dir() { # <slug>
  local id
  id="$(printf '%s' "$DOCS_ROOT" | shasum -a 256 | cut -c1-8)-$(basename "$DOCS_ROOT")"
  printf '%s/phase-console/runs/%s/%s/outcomes' "$XDG_STATE_HOME" "$id" "$1"
}

# The rulings ledger sits beside outcomes/: it is per PLAN, not per phase and
# not per run. Built from the id rather than from `inbox_dir`/.. — `..` only
# resolves through a directory that exists, and outcomes/ need not.
ledger_file() { # <slug>
  local id
  id="$(printf '%s' "$DOCS_ROOT" | shasum -a 256 | cut -c1-8)-$(basename "$DOCS_ROOT")"
  printf '%s/phase-console/runs/%s/%s/rulings.ndjson' "$XDG_STATE_HOME" "$id" "$1"
}

@test "outcome: waiting-external writes the exact JSON, atomically" {
  run pe_outcome demo 8 waiting-external --reason "img build" --watch "gh:x#run/1" --until 2026-08-10T21:40:00Z
  [ "$status" -eq 0 ]
  assert_contains "$output" "outcome recorded: demo phase 8 = waiting-external"
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 8,
  "status": "waiting-external",
  "reason": "img build",
  "resume_after": "2026-08-10T21:40:00Z",
  "watch": ["gh:x#run/1"],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
  # tmp+mv: no temp residue beside the target.
  [ -z "$(ls "$BATS_TEST_TMPDIR"/outcome.json.tmp.* 2>/dev/null || true)" ]
}

@test "outcome: complete with no options omits reason/resume_after and keeps an empty watch" {
  run pe_outcome demo 3 complete
  [ "$status" -eq 0 ]
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 3,
  "status": "complete",
  "watch": [],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
}

@test "outcome: --watch is repeatable and ordered" {
  run pe_outcome demo 8 waiting-external --watch a --watch b --watch "c d"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"watch": ["a", "b", "c d"],'
}

@test "outcome: reason newlines and quotes are sanitised for JSON" {
  reason="$(printf 'line one\nline "two"')"
  run pe_outcome demo 8 blocked --reason "$reason"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"reason": "line one line \"two\"",'
}

@test "outcome: without PE_OUTCOME_FILE the JSON goes to the console's inbox for this root AND to stdout, exit stays 0" {
  unset PE_OUTCOME_FILE
  run pe_outcome demo 8 waiting-external --until 2026-08-10T21:40:00Z
  [ "$status" -eq 0 ]
  assert_contains "$output" '"status": "waiting-external",'
  assert_contains "$output" 'PE_OUTCOME_FILE is not set'
  # runs/<sha256(root)[:8]-basename>/<slug>/outcomes/phase-NN.json — what the
  # convergence loop watches for a session nobody supervises.
  f="$(inbox_dir demo)/phase-08.json"
  assert_contains "$output" "$f"
  [ -f "$f" ]
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 8,
  "status": "waiting-external",
  "resume_after": "2026-08-10T21:40:00Z",
  "watch": [],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$f")" = "$expected" ]
  [ -z "$(ls "$(inbox_dir demo)"/*.tmp.* 2>/dev/null || true)" ]
}

@test "outcome: the unsupervised path derives the root the way phase-lock.sh does (git toplevel when DOCS_ROOT is unset)" {
  unset PE_OUTCOME_FILE
  unset DOCS_ROOT
  repo="$BATS_TEST_TMPDIR/repo"; mkdir -p "$repo/sub"
  git -C "$repo" init -q
  id="$(printf '%s' "$(cd "$repo" && pwd -P)" | shasum -a 256 | cut -c1-8)-repo"
  run bash -c "cd '$repo/sub' && '$SYS_BASH' '$PE_SCRIPTS/phase-outcome.sh' demo 2 partial --reason context"
  [ "$status" -eq 0 ]
  [ -f "$XDG_STATE_HOME/phase-console/runs/$id/demo/outcomes/phase-02.json" ]
}

@test "outcome: an unwritable state home still prints the JSON and exits 0" {
  unset PE_OUTCOME_FILE
  export XDG_STATE_HOME="/dev/null/nowhere"
  run pe_outcome demo 8 blocked --reason "x"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"status": "blocked",'
  assert_contains "$output" 'could not be'
}

@test "outcome: the session id rides along as session_id — PE_SESSION_ID first, else CLAUDE_CODE_SESSION_ID, sanitised" {
  PE_SESSION_ID="sess-1" run pe_outcome demo 8 complete
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"session_id": "sess-1",'
  CLAUDE_CODE_SESSION_ID="abc-2" run pe_outcome demo 8 complete
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"session_id": "abc-2",'
  PE_SESSION_ID="one" CLAUDE_CODE_SESSION_ID="two" run pe_outcome demo 8 complete
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"session_id": "one",'
  # Only id characters survive, so the line can never break the JSON.
  PE_SESSION_ID='we"ird id' run pe_outcome demo 8 complete
  assert_contains "$(cat "$PE_OUTCOME_FILE")" '"session_id": "weirdid",'
  # The exact-JSON pins above hold because no id was known there.
  run pe_outcome demo 8 complete
  refute_contains "$(cat "$PE_OUTCOME_FILE")" 'session_id'
}

@test "outcome: usage errors exit 2 (bad status, wait flags on non-waiting, both wait flags)" {
  run pe_outcome demo 8 finished
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 blocked --wait-minutes 30
  [ "$status" -eq 2 ]
  run pe_outcome demo 8 waiting-external --wait-minutes 30 --until 2026-08-10T21:40:00Z
  [ "$status" -eq 2 ]
  run pe_outcome demo eight complete
  [ "$status" -eq 2 ]
  [ ! -f "$PE_OUTCOME_FILE" ]
}

@test "outcome: --wait-minutes computes a resume_after timestamp" {
  run pe_outcome demo 8 waiting-external --wait-minutes 45
  [ "$status" -eq 0 ]
  grep -q '"resume_after": "20[0-9][0-9]-' "$PE_OUTCOME_FILE"
}

@test "outcome: partial writes the exact JSON — work remains, resume me" {
  run pe_outcome demo 5 partial --reason budget
  [ "$status" -eq 0 ]
  assert_contains "$output" "outcome recorded: demo phase 5 = partial"
  expected='{
  "version": 1,
  "slug": "demo",
  "phase": 5,
  "status": "partial",
  "reason": "budget",
  "watch": [],
  "written_at": "2026-08-10T21:10:03Z"
}'
  [ "$(cat "$PE_OUTCOME_FILE")" = "$expected" ]
  # The wait flags still belong to waiting-external only.
  run pe_outcome demo 5 partial --wait-minutes 10
  [ "$status" -eq 2 ]
}

# ---- rulings: what a session DECIDED, not how it ended ---------------------

@test "ruling: writes ONE exact NDJSON line, and the next one appends" {
  run pe_outcome demo 5 ruling --kind deviation --what "kept the old field" \
    --why "a reader predating it still exists" --cost-if-wrong "one dead branch"
  [ "$status" -eq 0 ]
  assert_contains "$output" "ruling recorded: demo phase 5 (deviation)"
  expected='{"version":1,"type":"ruling","slug":"demo","phase":5,"kind":"deviation","what":"kept the old field","why":"a reader predating it still exists","cost_if_wrong":"one dead branch","at":"2026-08-10T21:10:03Z"}'
  [ "$(cat "$PE_RULINGS_FILE")" = "$expected" ]

  PE_NOW="2026-08-10T22:00:00Z" run pe_outcome demo 6 ruling --what "left the sub-case to phase 9"
  [ "$status" -eq 0 ]
  # Appended, not replaced: two lines, the first untouched.
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "2" ]
  [ "$(head -1 "$PE_RULINGS_FILE")" = "$expected" ]
  second='{"version":1,"type":"ruling","slug":"demo","phase":6,"kind":"ambiguity","what":"left the sub-case to phase 9","at":"2026-08-10T22:00:00Z"}'
  [ "$(tail -1 "$PE_RULINGS_FILE")" = "$second" ]
}

@test "ruling: --kind defaults to ambiguity and an unknown kind exits 2 without writing" {
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"kind":"ambiguity"'

  rm -f "$PE_RULINGS_FILE"
  run pe_outcome demo 5 ruling --kind opinion --what "a choice"
  [ "$status" -eq 2 ]
  assert_contains "$output" "invalid --kind: opinion"
  [ ! -f "$PE_RULINGS_FILE" ]
}

@test "ruling: newlines, quotes and backslashes are sanitised into ONE json line" {
  what="$(printf 'chose "A"\nover B\\C')"
  run pe_outcome demo 5 ruling --what "$what"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$PE_RULINGS_FILE" | tr -d ' ')" = "1" ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"what":"chose \"A\" over B\\C"'
}

@test "ruling: --what is required, and the outcome flags are refused rather than ignored" {
  run pe_outcome demo 5 ruling
  [ "$status" -eq 2 ]
  assert_contains "$output" "--what is required"

  run pe_outcome demo 5 ruling --what x --watch "gh:a#run/1"
  [ "$status" -eq 2 ]
  assert_contains "$output" "belong to an outcome status"

  run pe_outcome demo 5 ruling --what x --wait-minutes 30
  [ "$status" -eq 2 ]
  assert_contains "$output" "belong to an outcome status"

  # ...and the other way round: a ruling flag on a real status is an error too.
  run pe_outcome demo 5 complete --what x
  [ "$status" -eq 2 ]
  assert_contains "$output" "only make sense with ruling"
  [ ! -f "$PE_RULINGS_FILE" ]
}

@test "ruling: the session id rides along, sanitised, and is omitted when unknown" {
  PE_SESSION_ID='we"ird id' run pe_outcome demo 5 ruling --what x
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$PE_RULINGS_FILE")" '"session_id":"weirdid"'
  rm -f "$PE_RULINGS_FILE"
  run pe_outcome demo 5 ruling --what x
  refute_contains "$(cat "$PE_RULINGS_FILE")" 'session_id'
}

@test "ruling: without PE_RULINGS_FILE the line goes to this root's ledger AND to stdout, exit stays 0" {
  unset PE_RULINGS_FILE
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"type":"ruling"'
  assert_contains "$output" 'PE_RULINGS_FILE is not set'
  f="$(ledger_file demo)"
  [ -f "$f" ]
  assert_contains "$(cat "$f")" '"what":"a choice"'
}

@test "ruling: an unwritable state home still prints the line and exits 0" {
  unset PE_RULINGS_FILE
  export XDG_STATE_HOME="/dev/null/nowhere"
  run pe_outcome demo 5 ruling --what "a choice"
  [ "$status" -eq 0 ]
  assert_contains "$output" '"what":"a choice"'
  assert_contains "$output" 'could not be written'
}
