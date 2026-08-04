#!/bin/bash
# Phase Console — double-click launcher.
#
# Starts the local console for phased-execution plans and opens it in your
# browser. By default it installs the console as a launchd agent and hands off
# to that, which is what makes the app's own Restart and Shut down buttons work:
# those buttons only exist where something will bring a clean exit back, and a
# double-clicked window cannot be that something — it IS the server's parent.
# See SUPERVISED below for the older "this window is the server" behaviour.
#
# Six knobs, edit below. The four switches are four separate decisions on
# purpose — each opens a different door, and a wider one is never implied by a
# narrower one:
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
#   TERM   --allow-terminal opens the Terminal page: a real shell in the browser,
#          running as you. Unlike a run, nothing supervises it — the policy is
#          whatever the person typing knows. Blank it out to keep the page off.
#   AGENT  --allow-agent opens the Agent page: interactive `claude` sessions in
#          that terminal, watched by the person in front of them rather than by
#          the console's policy. Narrower than TERM (the console builds the argv
#          from allowlisted fields, and the CLI still asks before it acts) and
#          wider than RUNS (no deny-list settings file, no approval hook in front
#          of it) — so it is its own switch, not a reading of either. Without it
#          the app answers "Agent sessions are disabled".
#
#   SUPERVISED
#          yes  install/keep a launchd agent (deploy/agent.sh) and open it. The
#               console survives closing this window and starts again at login,
#               and Restart / Shut down inside the app do what they say.
#          no   run the server in this window, the way this file used to. Closing
#               the window stops it, and the app's Restart button correctly
#               refuses — there would be nothing to come back.
#
#          Why the buttons need launchd specifically: Restart is a clean exit(0)
#          that KeepAlive brings back, and Shut down is `launchctl bootout` so it
#          STAYS down. Both are exit 0 from the server's side, so a plain
#          respawn loop here could not tell them apart — it would turn Shut down
#          into a restart, which is worse than no button at all.

ROOT="$HOME/work/hub"
WRITES="--allow-writes"
RUNS="--allow-run"
# Not `TERM`: that name already belongs to the terminal type every program on
# this machine reads, and overwriting it here breaks the console's own shell.
TERM_FLAG="--allow-terminal"
AGENT="--allow-agent"
PORT=4123
SUPERVISED="yes"

set -uo pipefail

LABEL="com.phase-console"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

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

open_browser() { [ -z "${PHASE_CONSOLE_NO_OPEN:-}" ] && open "http://127.0.0.1:$PORT"; }

wait_for_console() {  # wait_for_console <tries>
  local i
  for i in $(seq 1 "${1:-40}"); do
    curl -s -o /dev/null -m 1 "http://127.0.0.1:$PORT/api/state" && return 0
    sleep 0.25
  done
  return 1
}

# What a running console says it allows, as `true`/`false`.
state_field() { printf '%s' "$1" | grep -o "\"$2\":[a-z]*" | head -1 | cut -d: -f2; }
want() { [ -n "$1" ] && echo true || echo false; }

# The console flags already in the installed plist that this file does not
# manage — `--remote`/`--remote-user` for reaching the console from a phone,
# `--notify`, anything added by hand.
#
# This matters because `agent.sh install` writes a WHOLE plist from the
# arguments it is handed. Passing only the six knobs above would quietly delete
# remote access on the next double-click, and the symptom would appear hours
# later on a different device. They were a deliberate choice made elsewhere, so
# they are carried forward and named on screen rather than dropped in silence.
plist_args() {
  sed -n '/<key>ProgramArguments<\/key>/,/<\/array>/p' "$PLIST" 2>/dev/null \
    | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p'
}

carried=()
collect_carried() {
  [ -f "$PLIST" ] || return 0
  local args=() a i=2 flag next        # 0 = node, 1 = server/index.ts
  while IFS= read -r a; do args+=("$a"); done < <(plist_args)
  while [ "$i" -lt "${#args[@]}" ]; do
    flag="${args[$i]}"
    case "$flag" in
      --root|--port) i=$((i + 2)); continue ;;
      --no-open|--allow-writes|--allow-run|--allow-terminal|--allow-agent)
        i=$((i + 1)); continue ;;
      --*)
        next="${args[$((i + 1))]:-}"
        case "$next" in
          ''|--*) carried+=("$flag");        i=$((i + 1)) ;;
          *)      carried+=("$flag" "$next"); i=$((i + 2)) ;;
        esac ;;
      *) i=$((i + 1)) ;;                # a stray value; nothing to carry
    esac
  done
}

banner() {
  printf '\033]0;Phase Console\007'          # name the Terminal window
  echo "  source   ${ROOT:-choose one in the browser}"
  echo "  viewer   $VIEWER"
  echo "  writes   ${WRITES:-off (read-only)}"
  echo "  runs     ${RUNS:-off} ${RUNS:+— this console may spawn Claude sessions that edit $ROOT}"
  echo "  terminal ${TERM_FLAG:-off} ${TERM_FLAG:+— the Terminal page opens a real shell as you}"
  echo "  agent    ${AGENT:-off} ${AGENT:+— the Agent page runs interactive claude sessions}"
  echo
}

# =============================================================================
# Supervised: launchd owns the process, so the app's own buttons work.
# =============================================================================
if [ "$SUPERVISED" = yes ]; then
  if [ ! -d "$ROOT/docs/plans" ]; then
    # The agent bakes --root into its plist, so unlike the foreground mode there
    # is no "choose one in the browser" fallback — it needs a real directory.
    echo "SUPERVISED=yes needs a real ROOT — there is no docs/plans under:"
    echo "  $ROOT"
    echo
    echo "Fix ROOT at the top of this file, or set SUPERVISED=\"no\" to start in this"
    echo "window and pick a source directory in the browser."
    echo
    read -r -p "Press return to close. "
    exit 1
  fi

  # Re-install only when something actually differs. `agent.sh install` runs
  # npm ci + a client build, so doing it on every double-click would cost a
  # minute and hand every device a service-worker update it did not need.
  needs_install=0
  reason=""
  if [ ! -f "$PLIST" ]; then
    needs_install=1
    reason="not installed yet"
  else
    plist_has() { grep -qF "<string>$1</string>" "$PLIST"; }
    plist_wants() {  # plist_wants <flag-or-empty> <flag-name>
      if [ -n "$1" ]; then
        plist_has "$2" || reason="$reason $2(turn on)"
      else
        plist_has "$2" && reason="$reason $2(turn off)"
      fi
    }
    plist_has "$ROOT" || reason="$reason root"
    plist_has "$PORT" || reason="$reason port"
    plist_wants "$WRITES"    "--allow-writes"
    plist_wants "$RUNS"      "--allow-run"
    plist_wants "$TERM_FLAG" "--allow-terminal"
    plist_wants "$AGENT"     "--allow-agent"
    [ -n "$reason" ] && needs_install=1
  fi

  collect_carried

  echo "Phase Console — supervised by launchd ($LABEL)"
  banner
  [ "${#carried[@]}" -gt 0 ] && {
    echo "  keeping  ${carried[*]}"
    echo "           (already in the plist, not managed here — kept on re-install)"
    echo
  }

  if [ "$needs_install" = 1 ]; then
    echo "Installing the launchd agent (${reason# })…"
    echo "This builds the client first, so it takes a minute the first time."
    echo
    if ! bash "$VIEWER/deploy/agent.sh" install \
           --root "$ROOT" --port "$PORT" $WRITES $RUNS $TERM_FLAG $AGENT \
           ${carried[@]+"${carried[@]}"}; then
      echo
      echo "The agent did not install, so nothing was changed."
      echo
      read -r -p "Press return to close. "
      exit 1
    fi
    echo
  elif ! curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/api/state"; then
    # Installed and matching. KeepAlive plus RunAtLoad means it is normally
    # already up, so only nudge launchd when nothing answers.
    echo "Installed but not answering — asking launchd to start it…"
    launchctl kickstart -k "gui/$UID/$LABEL" >/dev/null 2>&1
  fi

  if wait_for_console 60; then
    open_browser
    echo "Running at http://127.0.0.1:$PORT"
    echo
    echo "Closing this window does NOT stop it — launchd keeps it running and starts it"
    echo "again at login. Restart and Shut down now work inside the app (Settings)."
    echo "From a terminal:  deploy/agent.sh {status|restart|log|uninstall}"
    echo "After a git pull: deploy/agent.sh update   (rebuilds, then restarts)"
    sleep 2
    exit 0
  fi

  echo "It is installed but never answered on port $PORT."
  echo "Logs: ~/.local/state/phase-console/console.err.log"
  echo
  read -r -p "Press return to close. "
  exit 1
fi

# =============================================================================
# Unsupervised: this window is the server (the original behaviour).
# =============================================================================

# A launchd agent from a previous SUPERVISED=yes run already holds the port, and
# would take it straight back the moment this window killed it. Say so instead
# of losing a fight with KeepAlive.
if [ -f "$PLIST" ]; then
  echo "A launchd agent ($LABEL) is installed, and it will keep taking port $PORT back."
  echo "Remove it first if you want this window to own the server:"
  echo "  $VIEWER/deploy/agent.sh uninstall"
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
  MISMATCH=""
  [ "$(state_field "$STATE" allowRun)"      != "$(want "$RUNS")" ]      && MISMATCH="$MISMATCH  runs:     running=$(state_field "$STATE" allowRun) wanted=$(want "$RUNS")\n"
  [ "$(state_field "$STATE" allowWrites)"   != "$(want "$WRITES")" ]    && MISMATCH="$MISMATCH  writes:   running=$(state_field "$STATE" allowWrites) wanted=$(want "$WRITES")\n"
  # Checked for the same reason as the other two: a console started without
  # these looks identical until you open Terminal or Agent and are told the
  # page is disabled — which reads as a broken app rather than as a flag.
  [ "$(state_field "$STATE" allowTerminal)" != "$(want "$TERM_FLAG")" ] && MISMATCH="$MISMATCH  terminal: running=$(state_field "$STATE" allowTerminal) wanted=$(want "$TERM_FLAG")\n"
  [ "$(state_field "$STATE" allowAgent)"    != "$(want "$AGENT")" ]     && MISMATCH="$MISMATCH  agent:    running=$(state_field "$STATE" allowAgent) wanted=$(want "$AGENT")\n"

  if [ -z "$MISMATCH" ]; then
    echo "Phase Console is already running on port $PORT — opening it."
    open_browser
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
      open_browser
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

echo "Phase Console"
banner
echo "Close this window (or press Ctrl-C) to stop the server."
echo "Nothing is supervising it, so the app's Restart button will refuse — set"
echo "SUPERVISED=\"yes\" at the top of this file if you want that button to work."
echo

# ---- open the browser once the server answers ------------------------------
( wait_for_console 40 && open_browser ) &

# ---- run in the foreground so this window owns the server ------------------
if [ -n "$ROOT" ]; then
  exec node "$VIEWER/server/index.ts" --root "$ROOT" --port "$PORT" $WRITES $RUNS $TERM_FLAG $AGENT
else
  exec node "$VIEWER/server/index.ts" --port "$PORT" $WRITES $RUNS $TERM_FLAG $AGENT
fi
