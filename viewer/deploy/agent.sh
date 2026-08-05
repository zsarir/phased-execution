#!/usr/bin/env bash
# Phase Console as a login agent — launchd on macOS, a systemd user service on
# Linux (including WSL2 with systemd enabled).
#
#   agent.sh install [--root DIR] [--port N] [--notify CMD] [--default-skills CSV]
#                    [extra console flags…]
#   agent.sh update              # npm ci + npm run build, then restart
#   agent.sh uninstall
#   agent.sh status
#   agent.sh start | stop        # start / stop the installed agent (stop ≠ uninstall)
#   agent.sh restart
#   agent.sh log [-f]
#
# Why an agent at all: the console supervises agent sessions that run for
# hours. A foreground process dies with its terminal, with a logout, and with
# any crash — and a supervisor that dies mid-run is worse than no supervisor.
# launchd/systemd restart it and start it at login.
#
# The plist/unit is generated rather than templated, so the node path, the
# working directory and the flags are whatever they actually are on this
# machine.
#
# The client is built output (`client/dist`, gitignored). `install` and
# `update` build it deliberately, and the supervisor's boot path never does: a
# restart must serve exactly what was verified, and a crash loop must not be
# able to spend its throttle interval rebuilding. After a `git pull`, run
# `agent.sh update`.
set -euo pipefail

LABEL="com.phase-console"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="phase-console.service"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
VIEWER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/phase-console"

OS="$(uname -s)"
IS_WSL=0
if [ "$OS" = "Linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi

die() { echo "phase-console agent: $*" >&2; exit 1; }

case "$OS" in
  Darwin|Linux) : ;;
  *) die "no supervisor here ($OS) — on Windows, run the console inside WSL2 (see docs/install.md)" ;;
esac

# The user manager is the whole mechanism on Linux; without it there is nothing
# to install into. WSL2 has had systemd since 2022, but only when asked for.
require_systemd() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    return 0
  fi
  if [ "$IS_WSL" -eq 1 ]; then
    die "this WSL distro is not running systemd. Enable it once:
  1. add to /etc/wsl.conf:      [boot]
                                systemd=true
  2. from Windows, run:         wsl --shutdown
  3. reopen the distro and re-run this install.
Until then, run the console directly: phase-console --root <dir> (tmux keeps it alive)."
  fi
  die "no systemd user manager is reachable — run the console directly instead:
  phase-console --root <dir>   (tmux or nohup keeps it alive across the terminal)"
}

# The supervisor gives a process a minimal PATH, but the console shells out to
# bash, git and the skill's scripts. Baking in the PATH from the shell that
# installs it is the only version that reliably matches what those scripts
# expect. ⚠️ That also means: after a toolchain move (new Homebrew python, nvm
# switch), re-run `agent.sh install` FROM A FULL SHELL — a verification once
# halted a run at 3 a.m. with `"python": executable file not found` because the
# plist still carried the thin PATH of the shell that installed it. The
# verifier now appends the standard dirs defensively (and logs
# `verify.path-amended` when it had to), but the plist staying honest is the
# real fix.
current_path="$PATH"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# systemd's own quoting: double quotes around each word, backslash-escaped
# quotes/backslashes, and doubled $ and % so nothing is expanded as a variable
# or a unit specifier.
sd_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/$$/g' -e 's/%/%%/g'; }

cmd_install() {
  local node_bin root="" port="4123" notify="" notify_given=0
  local default_skills="" skills_given=0 extra=()
  node_bin="$(command -v node)" || die "node is not on PATH"
  # The found node gets baked into the plist/unit — an old one would crash-loop
  # the agent with a TypeScript syntax error instead of failing here, once,
  # legibly.
  "$node_bin" -e 'const [maj, min] = process.versions.node.split(".").map(Number);
process.exit(maj >= 24 || (maj === 23 && min >= 6) || (maj === 22 && min >= 18) ? 0 : 1)' \
    || die "node $("$node_bin" -v) is too old — the server needs >=22.18 or >=23.6 (runs TypeScript directly)"
  [ "$OS" = "Linux" ] && require_systemd

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root) root="$2"; shift 2 ;;
      --port) port="$2"; shift 2 ;;
      --notify) notify="$2"; notify_given=1; shift 2 ;;
      --default-skills) default_skills="$2"; skills_given=1; shift 2 ;;
      # Swallowed, not carried: the plist always gets exactly one --no-open of
      # its own below. Passed through, a caller that (reasonably) includes it
      # duplicated the flag in ProgramArguments on every reinstall.
      --no-open) shift ;;
      *) extra+=("$1"); shift ;;
    esac
  done

  # The out-of-band leg. The supervisor hands a job a near-empty environment,
  # so a PHASE_CONSOLE_NOTIFY exported in a shell reaches the console started
  # from that shell and NOT the one started at login — which is the one that
  # matters, because it is the one running while you are asleep. That is why it
  # has never fired here: the variable was real and the plist never carried it.
  # Baked in, it is armed for every restart.
  #
  # Inherited from the installing shell unless --notify says otherwise, so an
  # existing setup keeps working; `--notify ''` clears it deliberately.
  if [ "$notify_given" -eq 0 ] && [ -n "${PHASE_CONSOLE_NOTIFY:-}" ]; then
    notify="$PHASE_CONSOLE_NOTIFY"
  fi
  # Same leg, same reason: skills every run should start with are a property of
  # THIS MACHINE, so they belong in the plist rather than in whichever shell
  # happened to start the console. `--default-skills ''` clears them deliberately.
  if [ "$skills_given" -eq 0 ] && [ -n "${PHASE_CONSOLE_DEFAULT_SKILLS:-}" ]; then
    default_skills="$PHASE_CONSOLE_DEFAULT_SKILLS"
  fi
  [ -n "$root" ] || die "install needs --root <dir> (the repo holding docs/plans)"
  [ -d "$root/docs/plans" ] || die "no docs/plans under $root"

  build_client

  mkdir -p "$STATE_DIR"

  # Node refuses to type-strip .ts under any node_modules directory, which is
  # where an npm global install lives — those tarballs ship a pre-stripped
  # server/index.js for exactly this. Everywhere else the .ts is the truth.
  local entry="$VIEWER_DIR/server/index.ts"
  case "$VIEWER_DIR" in
    */node_modules/*) [ -f "$VIEWER_DIR/server/index.js" ] && entry="$VIEWER_DIR/server/index.js" ;;
  esac

  # Arguments, one per line. --no-open matters: without it every restart would
  # fling a browser window at you.
  local args=("$node_bin" "$entry" --root "$root" --port "$port" --no-open)
  args+=("${extra[@]+"${extra[@]}"}")

  if [ "$OS" = "Darwin" ]; then
    install_darwin
  else
    install_linux
  fi

  echo "installed  $([ "$OS" = "Darwin" ] && echo "$PLIST" || echo "$UNIT_FILE")"
  echo "root       $root"
  echo "url        http://127.0.0.1:$port"
  echo "logs       $STATE_DIR/console.{out,err}.log"
  echo "notify     ${notify:-not set — pass --notify '<command>' for out-of-band alerts}"
  echo "skills     ${default_skills:-none — pass --default-skills a,b to seed every run}"
  echo
  echo "It is running now and will start at login. Stop it with: agent.sh uninstall"
  if [ "$OS" = "Linux" ]; then
    if command -v loginctl >/dev/null 2>&1 \
      && [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || true)" != "yes" ]; then
      echo "note: it stops at logout. To keep it running with no session open: loginctl enable-linger $USER"
    fi
    [ "$IS_WSL" -eq 1 ] && echo "note: WSL parks its VM when nothing is running — the console is up whenever WSL is."
  fi
  return 0
}

install_darwin() {
  mkdir -p "$HOME/Library/LaunchAgents"

  local arg_xml=""
  local a
  for a in "${args[@]}"; do
    arg_xml+="    <string>$(xml_escape "$a")</string>"$'\n'
  done

  local notify_xml=""
  if [ -n "$notify" ]; then
    notify_xml="    <key>PHASE_CONSOLE_NOTIFY</key><string>$(xml_escape "$notify")</string>"$'\n'
  fi

  local skills_xml=""
  if [ -n "$default_skills" ]; then
    skills_xml="    <key>PHASE_CONSOLE_DEFAULT_SKILLS</key><string>$(xml_escape "$default_skills")</string>"$'\n'
  fi

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
$notify_xml$skills_xml  </dict>
</dict>
</plist>
PLIST_END

  # Bootout first so a re-install replaces cleanly rather than erroring — but
  # bootout is ASYNCHRONOUS. Bootstrapping straight after it races the teardown
  # and fails with "Bootstrap failed: 5: Input/output error", which leaves the
  # old job gone and the new one never loaded: the console is simply down, and
  # the installer has already printed its success banner. Wait for the label to
  # actually disappear, then retry a few times.
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done

  bootstrapped=0
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null; then bootstrapped=1; break; fi
    [ "$attempt" -eq 1 ] && echo "launchd is still tearing the old job down — retrying…" >&2
    sleep 1
  done
  [ "$bootstrapped" -eq 1 ] || die "could not load $LABEL — the console is NOT running. Try: launchctl bootstrap gui/$UID $PLIST"
  launchctl enable "gui/$UID/$LABEL"

  # Prove it came up rather than assuming: a banner claiming success over a
  # dead console is worse than an error.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 && break
    sleep 0.5
  done
}

install_linux() {
  mkdir -p "$(dirname "$UNIT_FILE")"

  local exec_start=""
  local a
  for a in "${args[@]}"; do
    exec_start+="\"$(sd_escape "$a")\" "
  done

  local notify_line=""
  if [ -n "$notify" ]; then
    notify_line="Environment=\"PHASE_CONSOLE_NOTIFY=$(sd_escape "$notify")\""$'\n'
  fi
  local skills_line=""
  if [ -n "$default_skills" ]; then
    skills_line="Environment=\"PHASE_CONSOLE_DEFAULT_SKILLS=$(sd_escape "$default_skills")\""$'\n'
  fi

  # Restart=always is the KeepAlive=true of systemd: a clean exit comes
  # straight back, which is what makes the app's own Restart button work — and
  # what makes Stop mean `systemctl --user stop`, never just exiting.
  # %n expands to the unit's own name; the server reads PHASE_CONSOLE_UNIT to
  # know which unit file to check (the XPC_SERVICE_NAME of this platform).
  cat > "$UNIT_FILE" <<UNIT_END
[Unit]
Description=Phase Console — local web console for the phased-execution skill

[Service]
ExecStart=${exec_start% }
WorkingDirectory=$VIEWER_DIR
Restart=always
RestartSec=10
TimeoutStopSec=150
StandardOutput=append:$STATE_DIR/console.out.log
StandardError=append:$STATE_DIR/console.err.log
Environment="PATH=$(sd_escape "$current_path")"
Environment=PHASE_CONSOLE_NO_OPEN=1
Environment=PHASE_CONSOLE_UNIT=%n
$notify_line$skills_line
[Install]
WantedBy=default.target
UNIT_END

  systemctl --user daemon-reload
  systemctl --user reset-failed "$UNIT" 2>/dev/null || true
  systemctl --user enable "$UNIT" >/dev/null 2>&1
  # restart, not start: an already-running console must pick the new unit up.
  systemctl --user restart "$UNIT" \
    || die "could not start $UNIT — the console is NOT running. Read: journalctl --user -u $UNIT -n 50"

  # Prove it came up rather than assuming.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(systemctl --user is-active "$UNIT" 2>/dev/null || true)" = "active" ] && break
    sleep 0.5
  done
  [ "$(systemctl --user is-active "$UNIT" 2>/dev/null || true)" = "active" ] \
    || die "$UNIT did not reach active — read: $STATE_DIR/console.err.log"
}

# One implementation for install and update. `npm run build` stamps
# `dist/.build-rev` itself, so what the supervisor serves is always
# attributable to a commit. The build happens while any running console keeps
# serving — the static root is picked per request, so the seconds where dist is
# empty degrade to the not-built page and the fallback worker, never to a hang.
build_client() {
  # Packaged installs (npm, Homebrew) ship a prebuilt client and no sources or
  # lockfile — there is nothing to build here, and the shipped dist is
  # authoritative. Updates come through the package manager, not this script.
  if [ ! -e "$VIEWER_DIR/../.git" ] && [ -f "$VIEWER_DIR/client/dist/index.html" ]; then
    echo "packaged install — using the shipped client build"
    return 0
  fi
  command -v npm >/dev/null 2>&1 || die "npm is not on PATH — the client is built output"
  echo "building the client (npm ci && npm run build in $VIEWER_DIR)…"
  ( cd "$VIEWER_DIR" && npm ci --no-audit --no-fund && npm run build ) \
    || die "the client build failed — nothing was installed or restarted"
}

installed() {
  if [ "$OS" = "Darwin" ]; then [ -f "$PLIST" ]; else [ -f "$UNIT_FILE" ]; fi
}

agent_name() { if [ "$OS" = "Darwin" ]; then echo "$LABEL"; else echo "$UNIT"; fi; }

restart_agent() {
  if [ "$OS" = "Darwin" ]; then
    launchctl kickstart -k "gui/$UID/$LABEL"
  else
    systemctl --user restart "$UNIT"
  fi
}

cmd_start() {
  installed || die "not installed — use: agent.sh install --root <dir>"
  if [ "$OS" = "Darwin" ]; then
    # After a stop the job is unloaded — bootstrap loads AND starts it
    # (RunAtLoad). Already loaded, bootstrap refuses; kickstart (no -k) then
    # starts a stopped job and no-ops a running one. Idempotent either way.
    launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null \
      || launchctl kickstart "gui/$UID/$LABEL"
  else
    systemctl --user start "$UNIT"
  fi
  echo "started $(agent_name)"
}

cmd_stop() {
  installed || die "not installed"
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  else
    systemctl --user stop "$UNIT"
  fi
  echo "stopped $(agent_name)  (still installed — it returns at login; remove with: agent.sh uninstall)"
}

cmd_update() {
  installed || die "not installed — use: agent.sh install --root <dir>"
  build_client
  restart_agent
  echo "rebuilt and restarted $([ "$OS" = "Darwin" ] && echo "$LABEL" || echo "$UNIT")"
}

cmd_uninstall() {
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
  else
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "removed $UNIT"
  fi
}

cmd_status() {
  if ! installed; then echo "not installed"; return 1; fi
  if [ "$OS" = "Darwin" ]; then
    echo "plist    $PLIST"
    # print-disabled/print are noisy; the pid line is what anyone actually wants.
    if launchctl print "gui/$UID/$LABEL" 2>/dev/null | grep -E '^\s+(pid|state) ' ; then
      :
    else
      echo "state    loaded but not running"
    fi
  else
    echo "unit     $UNIT_FILE"
    # `show` never exits non-zero and never pages — the two failure modes of
    # `status` in a script.
    systemctl --user show "$UNIT" --property=ActiveState,SubState,MainPID --no-pager 2>/dev/null \
      | sed -e 's/^ActiveState=/state    /' -e 's/^SubState=/sub      /' -e 's/^MainPID=/pid      /'
  fi
}

cmd_restart() {
  installed || die "not installed"
  restart_agent
  echo "restarted $([ "$OS" = "Darwin" ] && echo "$LABEL" || echo "$UNIT")"
}

cmd_log() {
  local f="$STATE_DIR/console.log"
  [ -f "$f" ] || die "no log at $f yet"
  if [ "${1:-}" = "-f" ]; then tail -f "$f"; else tail -n 50 "$f"; fi
}

case "${1:-}" in
  install)   shift; cmd_install "$@" ;;
  update)    cmd_update ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  log)       shift; cmd_log "$@" ;;
  *) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
