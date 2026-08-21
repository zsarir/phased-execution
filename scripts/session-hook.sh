#!/usr/bin/env bash
# Session presence for Phase Console — a user-scope Claude Code hook.
#
# Installed (Settings ▸ Automation, or `phase-console install-hooks`) for
# SessionStart, SessionEnd and Stop, it tells the console that owns the session's
# working directory that a Claude session is live, still live, or ended — the
# channel an interactive `claude`, a console agent and an autopilot lane did not
# have: until now they could see each other only through lock files and leases.
# With it, a lock whose session has ENDED is debris the moment it ends, a lock
# whose session is live is a queue to wait in, and the Pulse shows the hand-run
# session beside the autopilot's lanes.
#
# Contract (bash 3.2, fail-open):
#   - reads the hook payload on stdin (bounded: 64 KiB), sed-grade extraction of
#     session_id · cwd · transcript_path · hook_event_name · source/reason
#     (both the field names this CLI sends and the documented ones are read);
#   - resolves the owning console like bin/btw does:
#       node <skill>/viewer/shared/instances.mjs shell --cwd "<cwd>"
#     (node looked for on PATH, then in Homebrew / /usr/local / volta / nvm);
#   - POSTs {"version":1,"session_id",…} to <url>/hooks/session with a 2 s
#     timeout; when no console answers (or there is no node to ask), drops the
#     same record into the instance's inbox —
#       <instance state dir>/sessions/inbox/<at>-<session_id>-<event>.json
#     which the console ingests when it is next up;
#   - on SessionStart prints additionalContext naming the session id and the
#     `phase-lock.sh --session <id>` instruction, so a hand-driven session can
#     claim its lock as itself;
#   - ALWAYS exits 0. A hook that could stop a session would be a session
#     killed by a console's absence. Nothing here is load-bearing for safety.
# Set PHASE_CONSOLE_HOOK_OFF=1 to make it a no-op.

# No `set -e`: every step is best effort and the exit is decided here.
set -u

[ "${PHASE_CONSOLE_HOOK_OFF:-}" = 1 ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"

# ---- the payload -------------------------------------------------------------
input="$(head -c 65536 2>/dev/null || true)"
[ -n "$input" ] || exit 0

# _jget <key> → the FIRST occurrence's string value, unescaped; '' when absent.
# First occurrence matters: `last_assistant_message` (Stop) may quote a whole
# payload, and the fields this reads all precede it in the CLI's own output.
# BSD sed: no `\|`, so "non-specials, then (escape + non-specials)*".
_jget() {
  local rest="${input#*\"$1\"}"
  [ "$rest" != "$input" ] || { printf ''; return 0; }
  printf '%s' "$rest" \
    | sed -n 's/^[[:space:]]*:[[:space:]]*"\([^"\\]*\(\\.[^"\\]*\)*\)".*/\1/p' \
    | head -1 \
    | sed 's/\\\//\//g; s/\\"/"/g; s/\\\\/\\/g'
}

session_id="$(_jget session_id | tr -cd 'A-Za-z0-9._-' | cut -c1-128)"
event="$(_jget hook_event_name)"
cwd="$(_jget cwd)"
transcript="$(_jget transcript_path)"
source_="$(_jget source)";  [ -n "$source_" ] || source_="$(_jget session_start_reason)"
reason="$(_jget reason)";   [ -n "$reason" ]  || reason="$(_jget session_end_reason)"

[ -n "$session_id" ] || exit 0
case "$event" in SessionStart|SessionEnd|Stop) : ;; *) exit 0 ;; esac
case "$cwd" in /*) : ;; *) cwd="$(pwd)" ;; esac

# ---- the owning console ------------------------------------------------------
# The same search viewer/run makes: PATH first, then the usual homes. No version
# floor here — instances.mjs is plain ESM and any node this decade runs it.
_find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidates="/opt/homebrew/bin /usr/local/bin $HOME/.volta/bin" v c
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for v in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -r); do
      candidates="$candidates $HOME/.nvm/versions/node/$v/bin"
    done
  fi
  for c in $candidates; do
    if [ -x "$c/node" ]; then printf '%s' "$c/node"; return 0; fi
  done
  return 1
}

url=""; state_dir=""; root=""
node_bin="$(_find_node 2>/dev/null || true)"
if [ -n "$node_bin" ] && [ -f "$SKILL_DIR/viewer/shared/instances.mjs" ]; then
  shell_out="$("$node_bin" "$SKILL_DIR/viewer/shared/instances.mjs" shell --cwd "$cwd" 2>/dev/null || true)"
  root="$(printf '%s\n' "$shell_out" | sed -n 's/^root=//p' | head -1)"
  url="$(printf '%s\n' "$shell_out" | sed -n 's/^url=//p' | head -1)"
  state_dir="$(printf '%s\n' "$shell_out" | sed -n 's/^state_dir=//p' | head -1)"
fi
if [ -z "$state_dir" ]; then
  # No node, or it could not answer (which is also what a directory no console
  # owns looks like): the bash half of the same identity rule — and a directory
  # with no project above it has no presence to record.
  root="$(pe_project_root_for "$cwd" 2>/dev/null || true)"
  [ -n "$root" ] || exit 0
  state_dir="$(pe_instance_state_dir "$root")"
fi
[ -n "${PHASE_CONSOLE_URL:-}" ] && url="$PHASE_CONSOLE_URL"

# ---- the record --------------------------------------------------------------
_js() { printf '%s' "$1" | tr '\000-\037' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
epoch="$(date +%s)"
user_="$(id -un 2>/dev/null || printf '')"
host_="$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf '')"
# The claude process: Claude Code exports CLAUDE_PID to its hooks; the hook's
# own parent is that process too (verified), so $PPID is the fallback. The
# console uses it as a second liveness signal — a session whose process is
# gone has ended even when no SessionEnd ever arrived (a crash, a kill -9).
pid="${CLAUDE_PID:-${PPID:-0}}"
case "$pid" in ''|*[!0-9]*) pid=0 ;; esac
body="{\"version\":1,\"session_id\":\"$session_id\",\"event\":\"$(_js "$event")\",\"cwd\":\"$(_js "$cwd")\",\"transcript_path\":\"$(_js "$transcript")\",\"source\":\"$(_js "$source_")\",\"reason\":\"$(_js "$reason")\",\"owner\":\"$(_js "${PE_OWNER:-}")\",\"scope\":\"$(_js "${PE_SCOPE:-}")\",\"user\":\"$(_js "$user_")\",\"host\":\"$(_js "$host_")\",\"pid\":$pid,\"root\":\"$(_js "$root")\",\"at\":\"$at\"}"

# ---- deliver: POST to the console, else the inbox ------------------------------
delivered=0
if [ -n "$url" ] && command -v curl >/dev/null 2>&1; then
  # A failed transfer is not delivery whatever it printed: curl's own exit
  # status is read first, then the HTTP code.
  if code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 \
      -X POST "$url/hooks/session" -H 'content-type: application/json' -H 'x-phase-console: 1' \
      --data-binary "$body" 2>/dev/null)"; then
    case "$code" in 2[0-9][0-9]) delivered=1 ;; esac
  fi
fi
if [ "$delivered" = 0 ] && [ -n "$state_dir" ]; then
  inbox="$state_dir/sessions/inbox"
  if mkdir -p "$inbox" 2>/dev/null; then
    f="$inbox/$epoch-$session_id-$event.json"
    if printf '%s\n' "$body" > "$f.tmp.$$" 2>/dev/null; then mv "$f.tmp.$$" "$f" 2>/dev/null || rm -f "$f.tmp.$$" 2>/dev/null; fi
  fi
fi

# ---- what the session is told ---------------------------------------------------
# Only at SessionStart, and only for a directory a console owns or could own —
# a shell in an unrelated directory is not told about phase locks.
if [ "$event" = SessionStart ] && [ -n "$root" ]; then
  if [ -n "${PE_SESSION_ID:-}" ]; then
    how="PE_SESSION_ID is already exported for this session, so scripts/phase-lock.sh records it by itself."
  else
    how="When you claim a phase lock by hand, pass it: scripts/phase-lock.sh <slug> claim <N> ... --session $session_id (or export PE_SESSION_ID=$session_id)."
  fi
  ctx="Phase Console session presence: this Claude session's id is $session_id. $how That lets the console show this session on the Pulse, queue autopilot lanes behind it while it lives, and release its lock the moment it ends."
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$(_js "$ctx")"
fi
exit 0
