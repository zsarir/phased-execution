#!/usr/bin/env bash
# Phase Console as a launchd agent.
#
#   agent.sh install [--root DIR] [--port N] [extra console flags…]
#   agent.sh uninstall
#   agent.sh status
#   agent.sh restart
#   agent.sh log [-f]
#
# Why an agent at all: the console supervises agent sessions that run for
# hours. A foreground process dies with its terminal, with a logout, and with
# any crash — and a supervisor that dies mid-run is worse than no supervisor.
# launchd restarts it and starts it at login.
#
# The plist is generated rather than templated, so the node path, the working
# directory and the flags are whatever they actually are on this machine.
set -euo pipefail

LABEL="com.phase-console"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
VIEWER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/phase-console"

die() { echo "phase-console agent: $*" >&2; exit 1; }

# launchd gives a process a minimal PATH, but the console shells out to bash,
# git and the skill's scripts. Baking in the PATH from the shell that installs
# it is the only version that reliably matches what those scripts expect.
current_path="$PATH"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

cmd_install() {
  local node_bin root="" port="4123" extra=()
  node_bin="$(command -v node)" || die "node is not on PATH"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root) root="$2"; shift 2 ;;
      --port) port="$2"; shift 2 ;;
      *) extra+=("$1"); shift ;;
    esac
  done
  [ -n "$root" ] || die "install needs --root <dir> (the repo holding docs/plans)"
  [ -d "$root/docs/plans" ] || die "no docs/plans under $root"

  mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"

  # Arguments, one <string> per line. --no-open matters: without it every
  # restart would fling a browser window at you.
  local args=("$node_bin" "$VIEWER_DIR/server/index.ts" --root "$root" --port "$port" --no-open)
  args+=("${extra[@]+"${extra[@]}"}")

  local arg_xml=""
  local a
  for a in "${args[@]}"; do
    arg_xml+="    <string>$(xml_escape "$a")</string>"$'\n'
  done

  cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
$arg_xml  </array>

  <key>WorkingDirectory</key><string>$(xml_escape "$VIEWER_DIR")</string>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>

  <!-- Long enough for the console's own 120s drain: launchd SIGKILLs at this
       deadline, and the default of 20s would cut a checkpoint in half. -->
  <key>ExitTimeOut</key><integer>150</integer>
  <key>ThrottleInterval</key><integer>10</integer>

  <key>StandardOutPath</key><string>$(xml_escape "$STATE_DIR/console.out.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$STATE_DIR/console.err.log")</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$current_path")</string>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
    <key>PHASE_CONSOLE_NO_OPEN</key><string>1</string>
  </dict>
</dict>
</plist>
PLIST_END

  # bootout first so a re-install replaces cleanly rather than erroring.
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST"
  launchctl enable "gui/$UID/$LABEL"

  echo "installed  $PLIST"
  echo "root       $root"
  echo "url        http://127.0.0.1:$port"
  echo "logs       $STATE_DIR/console.{out,err}.log"
  echo
  echo "It is running now and will start at login. Stop it with: agent.sh uninstall"
}

cmd_uninstall() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
}

cmd_status() {
  if [ ! -f "$PLIST" ]; then echo "not installed"; return 1; fi
  echo "plist    $PLIST"
  # print-disabled/print are noisy; the pid line is what anyone actually wants.
  if launchctl print "gui/$UID/$LABEL" 2>/dev/null | grep -E '^\s+(pid|state) ' ; then
    :
  else
    echo "state    loaded but not running"
  fi
}

cmd_restart() {
  [ -f "$PLIST" ] || die "not installed"
  launchctl kickstart -k "gui/$UID/$LABEL"
  echo "restarted $LABEL"
}

cmd_log() {
  local f="$STATE_DIR/console.log"
  [ -f "$f" ] || die "no log at $f yet"
  if [ "${1:-}" = "-f" ]; then tail -f "$f"; else tail -n 50 "$f"; fi
}

case "${1:-}" in
  install)   shift; cmd_install "$@" ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  restart)   cmd_restart ;;
  log)       shift; cmd_log "$@" ;;
  *) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
