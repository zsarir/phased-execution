#!/usr/bin/env bats
# session-hook.sh — the user-scope Claude Code hook that tells Phase Console a
# session is live / still live / ended. Fail-open by contract: it ALWAYS exits 0,
# whatever node, curl or the console are doing. node and curl are stubbed on
# PATH so the suite runs without a console and without a network, and so the
# two fallbacks (no console answering; no node to ask) are exercised.
load ../helpers/test_helper

setup() {
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  export STUB="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB"
  # Nothing inherited from the session this suite may itself be running in.
  unset PE_SESSION_ID PE_OWNER PE_SCOPE PHASE_CONSOLE_URL PHASE_CONSOLE_HOOK_OFF CLAUDE_CODE_SESSION_ID
  # A project directory for the session to be standing in.
  export PROJ="$BATS_TEST_TMPDIR/proj"
  mkdir -p "$PROJ/docs/plans"
  # node: answers `shell --cwd` with the contents of $NODE_STUB_FILE, else fails.
  cat > "$STUB/node" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "${STUB:?}/node.log"
if [ -n "${NODE_STUB_FILE:-}" ] && [ -f "$NODE_STUB_FILE" ]; then cat "$NODE_STUB_FILE"; exit 0; fi
exit 1
STUB
  # curl: records the URL and the body, answers the configured code.
  cat > "$STUB/curl" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "${STUB:?}/curl.log"
while [ $# -gt 0 ]; do
  case "$1" in
    --data-binary) printf '%s' "$2" > "$STUB/curl.body"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "${CURL_STUB_CODE:-200}"
exit "${CURL_STUB_EXIT:-0}"
STUB
  chmod +x "$STUB/node" "$STUB/curl"
  export PATH="$STUB:$PATH"
  export NODE_STUB_FILE="$BATS_TEST_TMPDIR/shell.out"
  # The console that owns $PROJ, as `instances.mjs shell --cwd` would describe it.
  cat > "$NODE_STUB_FILE" <<EOS
kind=registered
id=abcd1234-proj
name=proj
root=$PROJ
port=4999
url=http://127.0.0.1:4999
default=
unit=
generated_unit=com.phase-console.abcd1234-proj
unit_file=/dev/null
state_dir=$BATS_TEST_TMPDIR/sd
pid=
EOS
}

payload() { # <event> [extra-json-fields]
  printf '{"session_id":"s1","transcript_path":"/t/s1.jsonl","cwd":"%s","hook_event_name":"%s"%s}' "$PROJ" "$1" "${2:-}"
}

inbox_files() { find "$1" -type f -name '*.json' 2>/dev/null | sort; }

@test "hook: SessionStart POSTs the record to the owning console and tells the session its id" {
  run bash -c "printf '%s' '$(payload SessionStart ',"source":"startup"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  # node was asked about THIS cwd.
  grep -q -- "shell --cwd $PROJ" "$STUB/node.log"
  # one POST, to the console's /hooks/session
  grep -q "http://127.0.0.1:4999/hooks/session" "$STUB/curl.log"
  body="$(cat "$STUB/curl.body")"
  assert_contains "$body" '"version":1'
  assert_contains "$body" '"session_id":"s1"'
  assert_contains "$body" '"event":"SessionStart"'
  assert_contains "$body" "\"cwd\":\"$PROJ\""
  assert_contains "$body" '"transcript_path":"/t/s1.jsonl"'
  assert_contains "$body" '"source":"startup"'
  assert_contains "$body" "\"root\":\"$PROJ\""
  echo "$body" | grep -Eq '"pid":[0-9]+'
  echo "$body" | grep -Eq '"at":"20[0-9]{2}-'
  # delivered ⇒ no inbox file anywhere
  [ -z "$(inbox_files "$BATS_TEST_TMPDIR/sd")" ]
  [ -z "$(inbox_files "$XDG_STATE_HOME")" ]
  # the session is told its id and how to claim as itself
  assert_contains "$output" '"hookEventName":"SessionStart"'
  assert_contains "$output" 'additionalContext'
  assert_contains "$output" '--session s1'
  assert_contains "$output" 'PE_SESSION_ID=s1'
}

@test "hook: when the console does not answer, the record lands in the instance inbox instead" {
  CURL_STUB_EXIT=7 run bash -c "printf '%s' '$(payload SessionStart ',"source":"startup"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  f="$(inbox_files "$BATS_TEST_TMPDIR/sd/sessions/inbox")"
  [ -n "$f" ]
  case "$(basename "$f")" in *-s1-SessionStart.json) : ;; *) echo "bad name: $f"; false ;; esac
  assert_contains "$(cat "$f")" '"session_id":"s1"'
  assert_contains "$(cat "$f")" '"event":"SessionStart"'
  # tmp+mv: no residue
  [ -z "$(ls "$BATS_TEST_TMPDIR/sd/sessions/inbox"/*.tmp.* 2>/dev/null || true)" ]
  # still told its id
  assert_contains "$output" '--session s1'
}

@test "hook: a non-2xx answer is not delivery — the inbox gets it" {
  CURL_STUB_CODE=404 run bash -c "printf '%s' '$(payload SessionEnd ',"reason":"other"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  f="$(inbox_files "$BATS_TEST_TMPDIR/sd/sessions/inbox")"
  [ -n "$f" ]
  assert_contains "$(cat "$f")" '"event":"SessionEnd"'
  assert_contains "$(cat "$f")" '"reason":"other"'
}

@test "hook: SessionEnd and Stop say nothing to the session (stdout empty) and carry the reason" {
  run bash -c "printf '%s' '$(payload SessionEnd ',"reason":"prompt_input_exit"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  assert_contains "$(cat "$STUB/curl.body")" '"reason":"prompt_input_exit"'
  run bash -c "printf '%s' '$(payload Stop ',"stop_hook_active":false,"last_assistant_message":"ok"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  assert_contains "$(cat "$STUB/curl.body")" '"event":"Stop"'
}

@test "hook: the FIRST occurrence of a field wins — a quoted payload inside last_assistant_message cannot spoof cwd or session_id" {
  extra=',"last_assistant_message":"the hook got {\"session_id\":\"evil\",\"cwd\":\"/evil\"} earlier"'
  run bash -c "printf '%s' '$(payload Stop "$extra")' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  body="$(cat "$STUB/curl.body")"
  assert_contains "$body" '"session_id":"s1"'
  assert_contains "$body" "\"cwd\":\"$PROJ\""
  refute_contains "$body" '/evil'
}

@test "hook: the documented field names (session_start_reason / session_end_reason) are read too, and spaced JSON parses" {
  spaced="$(printf '{\n  "session_id": "s1",\n  "cwd": "%s",\n  "hook_event_name": "SessionStart",\n  "session_start_reason": "resume"\n}' "$PROJ")"
  run bash -c "printf '%s' '$spaced' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  assert_contains "$(cat "$STUB/curl.body")" '"source":"resume"'
  run bash -c "printf '%s' '$(payload SessionEnd ',"session_end_reason":"logout"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  assert_contains "$(cat "$STUB/curl.body")" '"reason":"logout"'
}

@test "hook: no node answer ⇒ no POST; the inbox is derived by the bash identity rule (default instance = flat state home)" {
  rm -f "$NODE_STUB_FILE"
  run bash -c "printf '%s' '$(payload SessionStart ',"source":"startup"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  [ ! -f "$STUB/curl.log" ]
  f="$(inbox_files "$XDG_STATE_HOME/phase-console/sessions/inbox")"
  [ -n "$f" ]
  assert_contains "$(cat "$f")" '"session_id":"s1"'
  assert_contains "$(cat "$f")" "\"root\":\"$PROJ\""
  assert_contains "$output" '--session s1'
}

@test "hook: no node answer, non-default instance ⇒ the inbox under instances/<id> (the dir a console created)" {
  rm -f "$NODE_STUB_FILE"
  id="$(printf '%s' "$PROJ" | shasum -a 256 | cut -c1-8)-proj"
  mkdir -p "$XDG_STATE_HOME/phase-console/instances/$id"
  run bash -c "printf '%s' '$(payload SessionEnd ',"reason":"other"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  f="$(inbox_files "$XDG_STATE_HOME/phase-console/instances/$id/sessions/inbox")"
  [ -n "$f" ]
  [ -z "$(inbox_files "$XDG_STATE_HOME/phase-console/sessions")" ]
}

@test "hook: a directory no project owns is nobody's business — nothing written, nothing said (no node answer)" {
  rm -f "$NODE_STUB_FILE"
  nowhere="$BATS_TEST_TMPDIR/nowhere"; mkdir -p "$nowhere"
  run bash -c "printf '{\"session_id\":\"s9\",\"cwd\":\"%s\",\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}' '$nowhere' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(inbox_files "$XDG_STATE_HOME")" ]
}

@test "hook: malformed payloads never fail the session — no session_id, unknown event, garbage, empty" {
  for bad in '{"cwd":"/x","hook_event_name":"SessionStart"}' '{"session_id":"s1","hook_event_name":"PreToolUse"}' 'not json at all' ''; do
    run bash -c "printf '%s' '$bad' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
  done
  [ ! -f "$STUB/curl.log" ]
  [ -z "$(inbox_files "$BATS_TEST_TMPDIR/sd")" ]
}

@test "hook: a runner-injected session (PE_SESSION_ID, PE_OWNER, PE_SCOPE) is told it is already known, and the record names its owner" {
  PE_SESSION_ID=s1 PE_OWNER=autopilot/ab12cd34 PE_SCOPE=web-app run bash -c "printf '%s' '$(payload SessionStart ',"source":"startup"')' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  assert_contains "$output" 'already exported'
  refute_contains "$output" '--session s1'
  body="$(cat "$STUB/curl.body")"
  assert_contains "$body" '"owner":"autopilot/ab12cd34"'
  assert_contains "$body" '"scope":"web-app"'
}

@test "hook: PHASE_CONSOLE_URL overrides the resolved console; PHASE_CONSOLE_HOOK_OFF=1 makes it a no-op" {
  PHASE_CONSOLE_URL=http://127.0.0.1:4777 run bash -c "printf '%s' '$(payload Stop)' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  grep -q "http://127.0.0.1:4777/hooks/session" "$STUB/curl.log"
  rm -f "$STUB/curl.log"
  PHASE_CONSOLE_HOOK_OFF=1 run bash -c "printf '%s' '$(payload SessionStart)' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -f "$STUB/curl.log" ]
}

@test "hook: the session id is kept to id characters and the record is one JSON line" {
  run bash -c "printf '{\"session_id\":\"s1 \\\\\"x\",\"cwd\":\"%s\",\"hook_event_name\":\"Stop\"}' '$PROJ' | '$SYS_BASH' '$PE_SCRIPTS/session-hook.sh'"
  [ "$status" -eq 0 ]
  body="$(cat "$STUB/curl.body")"
  assert_contains "$body" '"session_id":"s1x"'
  [ "$(printf '%s' "$body" | wc -l | tr -d ' ')" = "0" ]
}
