#!/usr/bin/env bash
# Declare a phase session's machine-readable OUTCOME — the record the autopilot
# reads instead of guessing from prose. Born from a live failure: a session that
# had done real work ended its turn "waiting on the image build (34-65 min)" in
# free text, the runner read the clean exit as completion, found no handoff, and
# halted the run. Prose has no parser; this file does.
#
# Usage: phase-outcome.sh <slug> <phase> <status> [--reason TEXT] [--watch REF]...
#                         [--wait-minutes N | --until ISO8601]
#        phase-outcome.sh <slug> <phase> ruling --what TEXT [--why TEXT]
#                         [--kind ambiguity|deviation|deferral] [--cost-if-wrong TEXT]
#   status: complete | waiting-external | blocked | needs-human | partial
#   partial   "work remains, resume me" — declared when the session must stop
#             before the exit criteria without anything being wrong (its
#             budget, its context); the runner resumes the session instead of
#             reading the clean exit as a failed phase. --reason conventionally
#             names why: budget | context | other
#   --wait-minutes / --until  only with waiting-external (absent -> the runner's
#                             default window); mutually exclusive
#   --watch   repeatable (max 8); free-form refs — conventional forms:
#             gh:<repo>#run/<id> · cmd:"<command>" · lock:<slug>/<phase>
#
# `ruling` is not a status and never becomes one: the five statuses above say
# how a session ENDED and the runner acts on each; a ruling says what a session
# DECIDED on the way, and nothing acts on it at all. That is what makes it safe
# to record whenever you are in doubt — it costs one line and it buys the next
# session a reader. It appends ONE NDJSON line to $PE_RULINGS_FILE (the runner
# injects it) or, unsupervised, to
#   <state>/phase-console/runs/<instance id>/<slug>/rulings.ndjson
# beside the outcomes/ inbox. Append-only: the console folds acks in as further
# lines rather than rewriting the file under a live session. Declaring a ruling
# does not declare an outcome — do both.
#
# Writes ONE atomic JSON file to $PE_OUTCOME_FILE (tmp+mv) — the runner injects
# that path into every session it supervises and consumes the file on exit.
# Without $PE_OUTCOME_FILE (no runner supervising this session) the file goes to
# the console's own inbox for this repository instead —
#   ${XDG_STATE_HOME:-~/.local/state}/phase-console/runs/<instance id>/<slug>/outcomes/phase-NN.json
# (the identity rule of viewer/shared/instances.mjs, mirrored in scripts/instance.sh) —
# where Phase Console's convergence loop picks it up: a human session's declared
# wait, block or partial drives the same machinery as a supervised one's. The JSON
# is still printed to stdout, the path is named on stderr, and the exit is 0: an
# interactive session following the same discipline must not die here, and the
# runner-side check — not this script — is the load-bearing enforcement.
# The session id rides along as "session_id" when the session knows it
# ($PE_SESSION_ID, runner-injected; else $CLAUDE_CODE_SESSION_ID, which Claude
# Code exports to its own subprocesses) so the console can resume THAT session.
# Exit: 0 written/printed · 2 usage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"

usage() {
  echo 'usage: phase-outcome.sh <slug> <phase> <complete|waiting-external|blocked|needs-human|partial>' >&2
  echo '                        [--reason TEXT] [--watch REF]... [--wait-minutes N | --until ISO8601]' >&2
  echo '       phase-outcome.sh <slug> <phase> ruling --what TEXT [--why TEXT]' >&2
  echo '                        [--kind ambiguity|deviation|deferral] [--cost-if-wrong TEXT]' >&2
  exit 2
}

slug="${1:-}"; phase="${2:-}"; status="${3:-}"
[ -n "$slug" ] && [ -n "$phase" ] && [ -n "$status" ] || usage
shift 3

case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
mode=outcome
case "$status" in
  complete|waiting-external|blocked|needs-human|partial) : ;;
  ruling) mode=ruling ;;
  *) echo "invalid status: $status (want complete|waiting-external|blocked|needs-human|partial, or ruling)" >&2; exit 2 ;;
esac

# JSON string sanitizer, bash 3.2 + BSD sed: control chars (newlines included)
# become spaces, then backslash and quote are escaped. Defined before the arg
# loop because --watch builds its JSON inline (bash 3.2 has no arrays worth
# passing around, so the refs are folded as they arrive).
_json_str() {
  printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

reason=""; wait_minutes=""; until_iso=""
watch_count=0; watch_json=""
what=""; why=""; kind=""; cost=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reason)       reason="${2:?--reason needs text}"; shift 2 ;;
    --what)         what="${2:?--what needs text}"; shift 2 ;;
    --why)          why="${2:?--why needs text}"; shift 2 ;;
    --kind)         kind="${2:?--kind needs a word}"; shift 2 ;;
    --cost-if-wrong) cost="${2:?--cost-if-wrong needs text}"; shift 2 ;;
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

# The two shapes share one option loop and are then held apart, so a flag that
# belongs to the other one is an error rather than a silent no-op.
if [ "$mode" = ruling ]; then
  if [ -n "$reason" ] || [ -n "$wait_minutes" ] || [ -n "$until_iso" ] || [ "$watch_count" -gt 0 ]; then
    echo '--reason/--watch/--wait-minutes/--until belong to an outcome status, not to a ruling' >&2; exit 2
  fi
  [ -n "$what" ] || { echo '--what is required for a ruling (say what you decided)' >&2; exit 2; }
  # Absent means the weakest of the three: a session that simply chose between
  # two readings has not deviated from anything, and recording it as a
  # deviation would put a disagreement in the ledger that never happened.
  [ -n "$kind" ] || kind=ambiguity
  case "$kind" in ambiguity|deviation|deferral) : ;; *)
    echo "invalid --kind: $kind (want ambiguity|deviation|deferral)" >&2; exit 2 ;; esac
elif [ -n "$what" ] || [ -n "$why" ] || [ -n "$kind" ] || [ -n "$cost" ]; then
  echo "--what/--why/--kind/--cost-if-wrong only make sense with ruling, not $status" >&2; exit 2
fi

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

# Read once, above both shapes: an outcome names the session so the console can
# resume it, and a ruling names it so a reader can find the transcript the
# decision was made in.
session="${PE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
session="$(printf '%s' "$session" | tr -cd 'A-Za-z0-9._-' | cut -c1-128)"

# ---- ruling: one appended NDJSON line, and nothing else happens ------------
# Deliberately before the outcome machinery rather than folded into it: a
# ruling has no resume clock, no watch refs and no consumer, and threading it
# through code that exists to arm one would be four `if`s to reach the same
# `>>`.
if [ "$mode" = ruling ]; then
  what="$(printf '%s' "$what" | cut -c1-500)"
  why="$(printf '%s' "$why" | cut -c1-800)"
  cost="$(printf '%s' "$cost" | cut -c1-300)"
  why_json="$( [ -n "$why" ] && printf ',"why":"%s"' "$(_json_str "$why")" || true )"
  cost_json="$( [ -n "$cost" ] && printf ',"cost_if_wrong":"%s"' "$(_json_str "$cost")" || true )"
  session_json="$( [ -n "$session" ] && printf ',"session_id":"%s"' "$session" || true )"
  # ONE line: the file is NDJSON and a pretty-printed record would make every
  # reader a parser with state.
  line="{\"version\":1,\"type\":\"ruling\",\"slug\":\"$(_json_str "$slug")\",\"phase\":$phase,\"kind\":\"$kind\",\"what\":\"$(_json_str "$what")\"${why_json}${cost_json}${session_json},\"at\":\"$(_json_str "$now")\"}"

  if [ -n "${PE_RULINGS_FILE:-}" ]; then
    ledger="$PE_RULINGS_FILE"
    if mkdir -p "$(dirname "$ledger")" 2>/dev/null && printf '%s\n' "$line" >> "$ledger" 2>/dev/null; then
      echo "ruling recorded: $slug phase $phase ($kind)  ->  $ledger"
    else
      echo "note: $ledger could not be written — printing the ruling only" >&2
      printf '%s\n' "$line"
    fi
  else
    root="$(pe_instance_root)"
    ledger="$(pe_runs_dir "$root" "$slug")/rulings.ndjson"
    if mkdir -p "$(dirname "$ledger")" 2>/dev/null && printf '%s\n' "$line" >> "$ledger" 2>/dev/null; then
      echo "note: PE_RULINGS_FILE is not set (no runner is supervising this session) — recorded for the console at $ledger" >&2
    else
      echo "note: PE_RULINGS_FILE is not set and $ledger could not be written — printing the ruling only" >&2
    fi
    printf '%s\n' "$line"
  fi
  exit 0
fi

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
session_line="$( [ -n "$session" ] && printf '\n  "session_id": "%s",' "$session" || true )"

json="{
  \"version\": 1,
  \"slug\": \"$(_json_str "$slug")\",
  \"phase\": $phase,
  \"status\": \"$status\",${reason_line}${resume_line}${session_line}
  \"watch\": [$watch_json],
  \"written_at\": \"$(_json_str "$now")\"
}"

if [ -n "${PE_OUTCOME_FILE:-}" ]; then
  tmp="$PE_OUTCOME_FILE.tmp.$$"
  printf '%s\n' "$json" > "$tmp"
  mv "$tmp" "$PE_OUTCOME_FILE"
  echo "outcome recorded: $slug phase $phase = $status  ->  $PE_OUTCOME_FILE"
else
  # Unsupervised: the console's inbox for this repository. Best-effort — a state
  # home that cannot be written (read-only HOME, no HOME at all) still leaves
  # the JSON on stdout for whoever is reading, and the exit stays 0.
  root="$(pe_instance_root)"
  inbox="$(pe_runs_dir "$root" "$slug")/outcomes"
  target="$inbox/phase-$(printf '%02d' "$phase").json"
  if mkdir -p "$inbox" 2>/dev/null; then
    tmp="$target.tmp.$$"
    if printf '%s\n' "$json" > "$tmp" 2>/dev/null && mv "$tmp" "$target" 2>/dev/null; then
      echo "note: PE_OUTCOME_FILE is not set (no runner is supervising this session) — recorded for the console at $target" >&2
    else
      rm -f "$tmp" 2>/dev/null || true
      echo "note: PE_OUTCOME_FILE is not set and $target could not be written — printing the outcome only" >&2
    fi
  else
    echo "note: PE_OUTCOME_FILE is not set and $inbox could not be created — printing the outcome only" >&2
  fi
  printf '%s\n' "$json"
fi
exit 0
