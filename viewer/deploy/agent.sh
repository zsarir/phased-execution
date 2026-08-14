#!/usr/bin/env bash
# Phase Console as a login agent — launchd on macOS, a systemd user service on
# Linux (including WSL2 with systemd enabled).
#
#   agent.sh install --root DIR | --instance NAME  [--port N] [--notify CMD]
#                    [--default-skills CSV] [extra console flags…]
#   agent.sh update [<instance>]   # npm ci + npm run build, then restart
#   agent.sh uninstall [<instance>]
#   agent.sh status [<instance>]   # no instance: every registered console
#   agent.sh start | stop [<instance>]   # start / stop it (stop ≠ uninstall)
#   agent.sh restart [<instance>]
#   agent.sh log [<instance>] [-f]
#
# <instance> is an id, a name, or a project's directory name — or `--instance
# <sel>` / `--root <dir>`. With none, the console for the directory you are
# standing in, walking up until one claims it.
#
# Why an agent at all: the console supervises agent sessions that run for
# hours. A foreground process dies with its terminal, with a logout, and with
# any crash — and a supervisor that dies mid-run is worse than no supervisor.
# launchd/systemd restart it and start it at login.
#
# The plist/unit is generated rather than templated, so the node path, the
# working directory and the flags are whatever they actually are on this
# machine — and, since one install now runs one console per project, so is the
# unit's own NAME: `com.phase-console.<id>` / `phase-console-<id>.service`. The
# default instance keeps the bare pre-1.3.0 names, so an operator upgrading
# never has their loaded agent renamed out from under them.
#
# The client is built output (`client/dist`, gitignored). `install` and
# `update` build it deliberately, and the supervisor's boot path never does: a
# restart must serve exactly what was verified, and a crash loop must not be
# able to spend its throttle interval rebuilding. After a `git pull`, run
# `agent.sh update`.
set -euo pipefail

VIEWER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCES="$VIEWER_DIR/shared/instances.mjs"

# Filled in by resolve_target(); every verb calls it before it touches a
# supervisor. There is no longer a single console to have constants for.
LABEL=""; PLIST=""; UNIT=""; UNIT_FILE=""; STATE_DIR=""
I_ID=""; I_NAME=""; I_ROOT=""; I_PORT=""; I_DEFAULT=""; I_UNIT=""

OS="$(uname -s)"
IS_WSL=0
if [ "$OS" = "Linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi

die() { echo "phase-console agent: $*" >&2; exit 1; }

case "$OS" in
  Darwin|Linux) : ;;
  *) die "no supervisor here ($OS) — on Windows, run the console inside WSL2 (see docs/install.md)" ;;
esac

# ---- which instance is this verb about? -------------------------------------
# The identity, the port derivation and the unit naming all live in
# shared/instances.mjs and are asked for, never reimplemented here: bash cannot
# reproduce the sha256 the rest of the system keys on (`sha256sum` reads echo's
# trailing newline and answers a different digest), and a second copy of the
# naming rule is a second thing to get out of step with the server.
#
# `shell` answers in `key=value` lines rather than JSON because this script may
# be running somewhere with neither jq nor python, and JSON cut apart with sed
# is how a path containing a brace becomes a unit filename.

TARGET_SELECTOR=""
TARGET_ROOT=""
TARGET_GIVEN=0
REST=()

# Pull an instance out of a verb's arguments; everything else lands in REST.
parse_target() {
  TARGET_SELECTOR=""; TARGET_ROOT=""; TARGET_GIVEN=0; REST=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --instance) TARGET_SELECTOR="${2:-}"; TARGET_GIVEN=1; shift 2 ;;
      --root)     TARGET_ROOT="${2:-}";     TARGET_GIVEN=1; shift 2 ;;
      -*)         REST+=("$1"); shift ;;
      *)
        # The first bare word is the instance; anything after it belongs to the
        # verb (there is none today, but `log alpha -f` must not lose the -f).
        if [ "$TARGET_GIVEN" -eq 0 ]; then TARGET_SELECTOR="$1"; TARGET_GIVEN=1; else REST+=("$1"); fi
        shift ;;
    esac
  done
}

resolve_target() {
  local out args=()
  if [ -n "$TARGET_ROOT" ]; then args=(--root "$TARGET_ROOT")
  elif [ -n "$TARGET_SELECTOR" ]; then args=("$TARGET_SELECTOR")
  else args=(--cwd "$PWD")
  fi

  command -v node >/dev/null 2>&1 || die "node is not on PATH"
  out="$(node "$INSTANCES" shell "${args[@]}" 2>&1)" || die "$out"

  I_ID=""; I_NAME=""; I_ROOT=""; I_PORT=""; I_DEFAULT=""; I_UNIT=""
  local generated="" unit_file="" key value
  # Not a pipeline: a `while read` on the right of a | runs in a subshell and
  # every assignment below would be discarded the moment the loop ended.
  while IFS='=' read -r key value; do
    # Keys this script has no use for (kind, pid — the pid fallback is
    # phase-console's, not the supervisor's) fall through and are ignored.
    case "$key" in
      id)             I_ID="$value" ;;
      name)           I_NAME="$value" ;;
      root)           I_ROOT="$value" ;;
      port)           I_PORT="$value" ;;
      default)        I_DEFAULT="$value" ;;
      unit)           I_UNIT="$value" ;;
      generated_unit) generated="$value" ;;
      unit_file)      unit_file="$value" ;;
      state_dir)      STATE_DIR="$value" ;;
    esac
  done <<TARGET_END
$out
TARGET_END

  [ -n "$I_ID" ] || die "could not work out which console this is about"

  if [ "$OS" = "Darwin" ]; then
    LABEL="$generated"; PLIST="$unit_file"; UNIT=""; UNIT_FILE=""
  else
    UNIT="$generated"; UNIT_FILE="$unit_file"; LABEL=""; PLIST=""
  fi
}

# The file this instance's unit lives in, whichever platform we are on.
target_unit_file() { if [ "$OS" = "Darwin" ]; then echo "$PLIST"; else echo "$UNIT_FILE"; fi; }

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

# Audit a PATH for entries that cannot serve: directories that do not exist,
# and directories under a DIFFERENT user's home — a live plist carried
# another user's macOS home from a migrated shell profile for weeks, and nothing
# ever said so. Warnings only (a thin PATH is degraded, not fatal; the
# verifier appends the standard dirs defensively): one finding per line on
# stdout, nothing when clean. bash 3.2.
audit_path() {  # audit_path <path>
  local IFS=':' d me
  me="$HOME"
  for d in $1; do
    [ -z "$d" ] && continue
    case "$d" in
      "$me"|"$me"/*) : ;;
      "/Use""rs/"*|/home/*)
        printf "PATH entry under a different user's home: %s\n" "$d"; continue ;;
    esac
    [ -d "$d" ] || printf 'PATH entry does not exist: %s\n' "$d"
  done
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# systemd's own quoting: double quotes around each word, backslash-escaped
# quotes/backslashes, and doubled $ and % so nothing is expanded as a variable
# or a unit specifier.
sd_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\$/$$/g' -e 's/%/%%/g'; }

cmd_install() {
  # No default port any more: 4123 belongs to the default instance, and handing
  # it to every install is precisely how two projects end up fighting over one
  # socket. Empty means "ask the instance", which answers 4123 for the default
  # and a derived slot for everyone else.
  local node_bin root="" port="" selector="" notify="" notify_given=0
  # The PATH this install bakes is the PATH every verification runs with —
  # name its defects NOW, while the person who can fix them is at a keyboard.
  local path_audit
  path_audit="$(audit_path "$current_path")"
  if [ -n "$path_audit" ]; then
    printf 'warning: the PATH this install will bake into the unit has issues:\n' >&2
    printf '%s\n' "$path_audit" | sed 's/^/  - /' >&2
    printf '  (install from a full shell of this account if that is unexpected)\n' >&2
  fi
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
      --instance) selector="$2"; shift 2 ;;
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
  # `--instance <name>` re-installs a console that is already registered, so a
  # reinstall after an upgrade does not need the path typed out again.
  if [ -z "$root" ] && [ -n "$selector" ]; then
    TARGET_SELECTOR="$selector"; TARGET_ROOT=""; resolve_target
    root="$I_ROOT"
  fi
  [ -n "$root" ] || die "install needs --root <dir> (the repo holding docs/plans)"
  [ -d "$root/docs/plans" ] || die "no docs/plans under $root"

  # Naming the path is exact: this instance, never a registered parent of it.
  TARGET_SELECTOR=""; TARGET_ROOT="$root"; resolve_target
  [ -n "$port" ] || port="$I_PORT"

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

  # Record what was just installed, so every other verb — and the console's own
  # UI — can find this instance by name instead of by path. The unit goes in
  # here too: it is what tells `phase-console start` there is something to
  # start rather than a foreground run to spawn.
  local register_args=("$root" --name "$I_NAME" --port "$port" --unit "$(agent_name)")
  [ -n "$I_DEFAULT" ] && register_args+=(--default)
  node "$INSTANCES" register "${register_args[@]}" >/dev/null \
    || echo "note: could not record this instance in the registry — the agent is installed and running anyway" >&2

  echo "installed  $(target_unit_file)"
  echo "instance   $I_NAME  ($I_ID)$([ -n "$I_DEFAULT" ] && echo "  default" || true)"
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

# Installed means: THIS instance's generated unit exists. Never "some console
# is installed on this machine" — with one console per project that question
# has no useful answer, and answering it wrongly is how `start` in project B
# reports success while project A's agent is what came up.
installed() {
  [ -f "$(target_unit_file)" ]
}

agent_name() { if [ "$OS" = "Darwin" ]; then echo "$LABEL"; else echo "$UNIT"; fi; }

# The same refusal from every verb, naming the instance it was about — "not
# installed" alone sends you to check the wrong project.
not_installed() {
  die "$I_NAME ($I_ID) has no agent installed — use: agent.sh install --root $I_ROOT"
}

restart_agent() {
  if [ "$OS" = "Darwin" ]; then
    launchctl kickstart -k "gui/$UID/$LABEL"
  else
    systemctl --user restart "$UNIT"
  fi
}

cmd_start() {
  parse_target "$@"; resolve_target
  installed || not_installed
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
  parse_target "$@"; resolve_target
  installed || not_installed
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  else
    systemctl --user stop "$UNIT"
  fi
  echo "stopped $(agent_name)  (still installed — it returns at login; remove with: agent.sh uninstall)"
}

cmd_update() {
  parse_target "$@"; resolve_target
  installed || not_installed
  build_client
  restart_agent
  echo "rebuilt and restarted $(agent_name)"
}

cmd_uninstall() {
  parse_target "$@"; resolve_target
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
  else
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  # The registry entry stays — the instance still exists, it simply has no
  # supervisor any more, and its port and name are still worth remembering for
  # the next `phase-console start`. Only the unit field is cleared, because a
  # unit named here that no longer exists is what makes `start` hand a
  # foreground run over to a supervisor that is not there.
  if [ -n "$I_UNIT" ]; then
    node "$INSTANCES" update "$I_ID" --unit "" >/dev/null 2>&1 || true
  fi
  echo "removed $(agent_name)  ($I_NAME is still registered — forget it entirely with: node $INSTANCES remove $I_ID)"
}

# No selector, and consoles are registered? Report all of them: with one
# console per project the honest answer to a bare "status" is the board, not
# whichever one happens to be nearest the shell you typed it in.
cmd_status() {
  parse_target "$@"
  if [ "$TARGET_GIVEN" -eq 0 ] && [ -n "$(node "$INSTANCES" list 2>/dev/null || true)" ]; then
    status_all
    return 0
  fi
  resolve_target
  if ! installed; then echo "not installed  ($I_NAME — $I_ROOT)"; return 1; fi
  echo "instance $I_NAME  ($I_ID)"
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
  # The PATH the unit actually runs with, audited — dead directories and
  # foreign homes are exactly the defects nothing else ever reports.
  local unit_path="" path_audit
  if [ "$OS" = "Darwin" ]; then
    # The writer puts key and string on ONE line; older hand-edited plists may
    # break them across two. Try same-line first, then the next-line shape.
    unit_path="$(sed -n 's/.*<key>PATH<\/key><string>\(.*\)<\/string>.*/\1/p' "$PLIST" 2>/dev/null | head -1)"
    [ -n "$unit_path" ] || \
      unit_path="$(sed -n '/<key>PATH<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$PLIST" 2>/dev/null | head -1)"
  else
    unit_path="$(grep -o 'Environment="PATH=[^"]*"' "$UNIT_FILE" 2>/dev/null | head -1 \
      | sed 's/^Environment="PATH=//; s/"$//')"
  fi
  if [ -n "$unit_path" ]; then
    path_audit="$(audit_path "$unit_path")"
    if [ -n "$path_audit" ]; then
      echo "path     the unit's baked PATH has issues:"
      printf '%s\n' "$path_audit" | sed 's/^/           - /'
      echo "           fix: re-run deploy/agent.sh install from a full shell"
    else
      echo "path     ok (no dead or foreign entries)"
    fi
  fi
  [ -z "${PE_MCP_SERVERS+set}" ] && \
    echo "note     PE_MCP_SERVERS is not set in this shell — scripts/validate.sh run by hand skips the F15 MCP advisory (console-spawned sessions carry it)"
  return 0
}

# Only the ID is read out of `list`; everything else comes from resolving that
# id. Not a style choice — TAB is an IFS *whitespace* character, so bash's
# `read` collapses runs of it and silently drops empty fields. An instance that
# is not the default has an empty `default` column, so every value after it
# shifted left by one and each non-default console reported as the default,
# with someone else's root beside it.
status_all() {
  local id
  printf '%-24s %-12s %-6s %-10s %s\n' INSTANCE NAME PORT SUPERVISOR ROOT
  while read -r id; do
    [ -n "$id" ] || continue
    TARGET_SELECTOR="$id"; TARGET_ROOT=""; TARGET_GIVEN=1
    resolve_target
    printf '%-24s %-12s %-6s %-10s %s\n' \
      "$I_ID" "$I_NAME" "${I_PORT:-—}" \
      "$(installed && echo installed || echo none)" \
      "$I_ROOT${I_DEFAULT:+  (default)}"
  done <<STATUS_END
$(node "$INSTANCES" list | cut -f1)
STATUS_END
}

cmd_restart() {
  parse_target "$@"; resolve_target
  installed || not_installed
  restart_agent
  echo "restarted $(agent_name)"
}

cmd_log() {
  parse_target "$@"
  resolve_target
  set -- ${REST[@]+"${REST[@]}"}
  local f="$STATE_DIR/console.log"
  [ -f "$f" ] || die "no log at $f yet"
  if [ "${1:-}" = "-f" ]; then tail -f "$f"; else tail -n 50 "$f"; fi
}

case "${1:-}" in
  install)   shift; cmd_install "$@" ;;
  update)    shift; cmd_update "$@" ;;
  uninstall) shift; cmd_uninstall "$@" ;;
  status)    shift; cmd_status "$@" ;;
  start)     shift; cmd_start "$@" ;;
  stop)      shift; cmd_stop "$@" ;;
  restart)   shift; cmd_restart "$@" ;;
  log)       shift; cmd_log "$@" ;;
  # The usage block is the header's own first paragraph — kept in one place so
  # a verb added above cannot quietly stop being documented here.
  *) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
