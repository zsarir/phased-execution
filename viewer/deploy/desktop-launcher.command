#!/bin/bash
# Phase Console — double-click launcher.
#
# Starts the local console for phased-execution plans and opens it in your
# browser. This window IS the server: closing it (or Ctrl-C) stops it.
#
# Three knobs, edit below:
#   ROOT   the repository to read (any directory with docs/plans; you can also
#          switch source directories inside the app)
#   WRITES --allow-writes lets the app scaffold plans/handoffs, record QA and
#          manage phase locks, each behind a confirmation. It never commits or
#          pushes. Blank it out for a strictly read-only session.
#   RUNS   --allow-run turns on the autopilot: the app may spawn Claude sessions
#          that edit ROOT unattended, one per phase, for as long as a run lasts.
#          A much larger blast radius than WRITES, which is why it is a separate
#          switch. Two things still hold whatever a run decides: the deny list
#          (git push, terraform apply, sudo, publishing — enforced inside Claude
#          Code itself) and per-run dollar budgets you set in the app. Blank it
#          out to watch runs without being able to start one.

ROOT="$HOME/work/hub"
WRITES="--allow-writes"
RUNS="--allow-run"
PORT=4123

set -uo pipefail

# ---- locate the viewer (the skill is cloned into one or more Claude homes) --
VIEWER=""
for home in "$HOME/.claude" "$HOME/.claude-a" "$HOME/.claude-b"; do
  if [ -f "$home/skills/phased-execution/viewer/server/index.ts" ]; then
    VIEWER="$home/skills/phased-execution/viewer"
    break
  fi
done

if [ -z "$VIEWER" ]; then
  echo "Phase Console is not installed."
  echo "Expected it at ~/.claude/skills/phased-execution/viewer — pull the claude-skills repo."
  echo
  read -r -p "Press return to close. "
  exit 1
fi

# ---- node check ------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  # A double-clicked .command gets a login shell without a version manager's
  # PATH, so look where node usually lives before giving up.
  for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.nvm/versions/node"/*/bin; do
    [ -x "$candidate/node" ] && PATH="$candidate:$PATH" && break
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required (22.6 or newer) and was not found on PATH."
  echo
  read -r -p "Press return to close. "
  exit 1
fi

# ---- already running? -------------------------------------------------------
# Attaching to whatever is already on the port is only right when it was started
# the same way this launcher would start it. A console running without
# --allow-run looks identical until you try to start a run and are told you
# cannot, so a mismatch is reported and offered a restart instead of hidden.
if STATE=$(curl -s -m 2 "http://127.0.0.1:$PORT/api/state"); then
  field() { printf '%s' "$STATE" | grep -o "\"$1\":[a-z]*" | head -1 | cut -d: -f2; }
  want() { [ -n "$1" ] && echo true || echo false; }

  MISMATCH=""
  [ "$(field allowRun)"    != "$(want "$RUNS")" ]   && MISMATCH="$MISMATCH  runs:   running=$(field allowRun) wanted=$(want "$RUNS")\n"
  [ "$(field allowWrites)" != "$(want "$WRITES")" ] && MISMATCH="$MISMATCH  writes: running=$(field allowWrites) wanted=$(want "$WRITES")\n"

  if [ -z "$MISMATCH" ]; then
    echo "Phase Console is already running on port $PORT — opening it."
    [ -z "${PHASE_CONSOLE_NO_OPEN:-}" ] && open "http://127.0.0.1:$PORT"
    sleep 1
    exit 0
  fi

  echo "A Phase Console is already running on port $PORT, but not with these settings:"
  echo
  printf "%b" "$MISMATCH"
  echo
  echo "It was probably started before you changed the settings at the top of this file."
  read -r -p "Restart it with the settings above? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|YES)
      lsof -ti "tcp:$PORT" 2>/dev/null | xargs -r kill
      for _ in $(seq 1 20); do
        curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/state" || break
        sleep 0.25
      done
      echo "Stopped. Starting again…"
      echo
      ;;
    *)
      echo "Left it alone — opening the console as it is."
      [ -z "${PHASE_CONSOLE_NO_OPEN:-}" ] && open "http://127.0.0.1:$PORT"
      sleep 1
      exit 0
      ;;
  esac
elif lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  # Something holds the port but will not answer. Nearly always a console whose
  # terminal was closed: the process outlives the window on purpose so a run is
  # not killed, and if it has since wedged it keeps the port without serving
  # anything. Falling through here produces a bare "address already in use",
  # which describes the symptom and hides the cause.
  echo "Something is holding port $PORT but is not responding."
  echo "That is usually a console whose window was closed and has since stopped serving."
  echo
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print "  pid " $2 "  " $1}'
  echo
  read -r -p "Stop it and start a fresh one? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|YES)
      lsof -ti "tcp:$PORT" 2>/dev/null | xargs -r kill
      sleep 1
      lsof -ti "tcp:$PORT" 2>/dev/null | xargs -r kill -9
      sleep 1
      echo "Stopped. Starting again…"
      echo
      ;;
    *)
      echo "Left it alone. Nothing is listening usefully on $PORT."
      read -r -p "Press return to close. "
      exit 1
      ;;
  esac
fi

[ -d "$ROOT" ] || ROOT=""   # missing directory → start on the source picker

printf '\033]0;Phase Console\007'          # name the Terminal window
echo "Phase Console"
echo "  source   ${ROOT:-choose one in the browser}"
echo "  viewer   $VIEWER"
echo "  writes   ${WRITES:-off (read-only)}"
echo "  runs     ${RUNS:-off} ${RUNS:+— this console may spawn Claude sessions that edit $ROOT}"
echo
echo "Close this window (or press Ctrl-C) to stop the server."
echo

# ---- open the browser once the server answers ------------------------------
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/state"; then
      [ -z "${PHASE_CONSOLE_NO_OPEN:-}" ] && open "http://127.0.0.1:$PORT"
      exit 0
    fi
    sleep 0.25
  done
) &

# ---- run in the foreground so this window owns the server ------------------
if [ -n "$ROOT" ]; then
  exec node "$VIEWER/server/index.ts" --root "$ROOT" --port "$PORT" $WRITES $RUNS
else
  exec node "$VIEWER/server/index.ts" --port "$PORT" $WRITES $RUNS
fi
