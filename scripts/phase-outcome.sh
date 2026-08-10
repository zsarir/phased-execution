#!/usr/bin/env bash
# Declare a phase session's machine-readable OUTCOME — the record the autopilot
# reads instead of guessing from prose. Born from a live failure: a session that
# had done real work ended its turn "waiting on the image build (34-65 min)" in
# free text, the runner read the clean exit as completion, found no handoff, and
# halted the run. Prose has no parser; this file does.
#
# Usage: phase-outcome.sh <slug> <phase> <status> [--reason TEXT] [--watch REF]...
#                         [--wait-minutes N | --until ISO8601]
#   status: complete | waiting-external | blocked | needs-human
#   --wait-minutes / --until  only with waiting-external (absent -> the runner's
#                             default window); mutually exclusive
#   --watch   repeatable (max 8); free-form refs — conventional forms:
#             gh:<repo>#run/<id> · cmd:"<command>" · lock:<slug>/<phase>
#
# Writes ONE atomic JSON file to $PE_OUTCOME_FILE (tmp+mv) — the runner injects
# that path into every session it supervises and consumes the file on exit.
# Without $PE_OUTCOME_FILE (no runner supervising this session) the JSON goes to
# stdout with a note on stderr and the exit is still 0: an interactive session
# following the same discipline must not die here, and the runner-side check —
# not this script — is the load-bearing enforcement.
# Exit: 0 written/printed · 2 usage
set -euo pipefail

usage() {
  echo 'usage: phase-outcome.sh <slug> <phase> <complete|waiting-external|blocked|needs-human>' >&2
  echo '                        [--reason TEXT] [--watch REF]... [--wait-minutes N | --until ISO8601]' >&2
  exit 2
}

slug="${1:-}"; phase="${2:-}"; status="${3:-}"
[ -n "$slug" ] && [ -n "$phase" ] && [ -n "$status" ] || usage
shift 3

case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
case "$status" in complete|waiting-external|blocked|needs-human) : ;; *)
  echo "invalid status: $status (want complete|waiting-external|blocked|needs-human)" >&2; exit 2 ;; esac

# JSON string sanitizer, bash 3.2 + BSD sed: control chars (newlines included)
# become spaces, then backslash and quote are escaped. Defined before the arg
# loop because --watch builds its JSON inline (bash 3.2 has no arrays worth
# passing around, so the refs are folded as they arrive).
_json_str() {
  printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

reason=""; wait_minutes=""; until_iso=""
watch_count=0; watch_json=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reason)       reason="${2:?--reason needs text}"; shift 2 ;;
    --wait-minutes) wait_minutes="${2:?--wait-minutes needs a number}"; shift 2 ;;
    --until)        until_iso="${2:?--until needs an ISO8601 time}"; shift 2 ;;
    --watch)
      ref="${2:?--watch needs a ref}"
      if [ "$watch_count" -lt 8 ]; then
        ref="$(printf '%s' "$ref" | cut -c1-200)"
        watch_json="${watch_json:+$watch_json, }\"$(_json_str "$ref")\""
        watch_count=$((watch_count + 1))
      else
        echo "ignoring --watch beyond the 8th: $ref" >&2
      fi
      shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$wait_minutes" ] && [ -n "$until_iso" ]; then
  echo '--wait-minutes and --until are mutually exclusive' >&2; exit 2
fi
if { [ -n "$wait_minutes" ] || [ -n "$until_iso" ]; } && [ "$status" != waiting-external ]; then
  echo "--wait-minutes/--until only make sense with waiting-external, not $status" >&2; exit 2
fi
if [ -n "$wait_minutes" ]; then
  case "$wait_minutes" in ''|*[!0-9]*) echo "--wait-minutes must be a number, got: $wait_minutes" >&2; exit 2 ;; esac
fi
if [ -n "$until_iso" ]; then
  case "$until_iso" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]*) : ;;
    *) echo "--until must be ISO8601 (YYYY-MM-DDTHH:MM...), got: $until_iso" >&2; exit 2 ;;
  esac
fi

# Reason is capped so a pasted log cannot bloat the record the runner
# journals verbatim.
reason="$(printf '%s' "$reason" | cut -c1-500)"

# PE_NOW pins the clock for tests (same idea as PE_TODAY in gate-approve.sh).
now="${PE_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

resume_after=""
if [ "$status" = waiting-external ]; then
  if [ -n "$until_iso" ]; then
    resume_after="$until_iso"
  elif [ -n "$wait_minutes" ]; then
    # BSD date first (macOS system bash pairs with BSD date), GNU as fallback.
    resume_after="$(date -u -v"+${wait_minutes}M" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -d "+${wait_minutes} minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  fi
fi

# Optional fields render as whole lines or not at all; the `|| true` keeps a
# skipped field from failing the assignment under `set -e` (an assignment's
# exit status is its last command substitution's).
reason_line="$( [ -n "$reason" ] && printf '\n  "reason": "%s",' "$(_json_str "$reason")" || true )"
resume_line="$( [ -n "$resume_after" ] && printf '\n  "resume_after": "%s",' "$(_json_str "$resume_after")" || true )"

json="{
  \"version\": 1,
  \"slug\": \"$(_json_str "$slug")\",
  \"phase\": $phase,
  \"status\": \"$status\",${reason_line}${resume_line}
  \"watch\": [$watch_json],
  \"written_at\": \"$(_json_str "$now")\"
}"

if [ -n "${PE_OUTCOME_FILE:-}" ]; then
  tmp="$PE_OUTCOME_FILE.tmp.$$"
  printf '%s\n' "$json" > "$tmp"
  mv "$tmp" "$PE_OUTCOME_FILE"
  echo "outcome recorded: $slug phase $phase = $status  ->  $PE_OUTCOME_FILE"
else
  echo 'note: PE_OUTCOME_FILE is not set (no runner is supervising this session) — printing the outcome instead' >&2
  printf '%s\n' "$json"
fi
exit 0
