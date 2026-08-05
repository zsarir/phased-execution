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

# Bumped whenever this file changes in a way a copy of it needs. The Desktop
# launcher is a COPY, not a link — so a `git pull` improves the repo's version
# and leaves the one you double-click untouched. That is how a console with no
# SUPERVISED knob kept starting unsupervised while this file said it would not.
# Comparing revisions rather than bytes means your own edits to the knobs above
# never look like staleness.
LAUNCHER_REV=4

set -uo pipefail

LABEL="com.phase-console"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# ---- locate the viewer -----------------------------------------------------
# A clone lives in a Claude home; a packaged install lives wherever npm or
# Homebrew put it. PHASE_CONSOLE_HOME (the package root) always wins.
VIEWER=""
if [ -n "${PHASE_CONSOLE_HOME:-}" ] && [ -f "$PHASE_CONSOLE_HOME/viewer/server/index.ts" ]; then
  VIEWER="$PHASE_CONSOLE_HOME/viewer"
fi
if [ -z "$VIEWER" ]; then
  for home in "$HOME/.claude" "$HOME/.claude-a" "$HOME/.claude-b"; do
    if [ -f "$home/skills/phased-execution/viewer/server/index.ts" ]; then
      VIEWER="$home/skills/phased-execution/viewer"
      break
    fi
  done
fi
if [ -z "$VIEWER" ]; then
  for pkg_root in "$(npm root -g 2>/dev/null)/phase-console" \
                  "$(brew --prefix phase-console 2>/dev/null)/libexec"; do
    if [ -f "$pkg_root/viewer/server/index.ts" ]; then
      VIEWER="$pkg_root/viewer"
      break
    fi
  done
fi

if [ -z "$VIEWER" ]; then
  echo "Phase Console is not installed."
  echo "Expected a clone at ~/.claude/skills/phased-execution, an npm install"
  echo "(npm i -g phase-console), or a Homebrew install — or set PHASE_CONSOLE_HOME."
  echo
  read -r -p "Press return to close. "
  exit 1
fi

# ---- node check ------------------------------------------------------------
# The server runs TypeScript natively, which needs node >=22.18 or >=23.6
# (23.0-23.5 still kept type stripping behind a flag). Finding *a* node is not
# enough — an old one produces a syntax-error stack in this window that reads
# as "the console is broken", so the version is checked wherever a candidate
# is found.
node_ok() { "$1" -e 'const [maj, min] = process.versions.node.split(".").map(Number);
process.exit(maj >= 24 || (maj === 23 && min >= 6) || (maj === 22 && min >= 18) ? 0 : 1)' 2>/dev/null; }

if ! command -v node >/dev/null 2>&1 || ! node_ok "$(command -v node)"; then
  # A double-clicked .command gets a login shell without a version manager's
  # PATH, so look where node usually lives before giving up. nvm keeps every
  # installed version side by side and a plain glob walks them ALPHABETICALLY
  # (v10 sorts before v8) — take the newest that satisfies the check instead.
  candidates=(/opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin")
  if [ -d "$HOME/.nvm/versions/node" ]; then
    while IFS= read -r v; do candidates+=("$HOME/.nvm/versions/node/$v/bin"); done \
      < <(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -rV)
  fi
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate/node" ] && node_ok "$candidate/node"; then
      PATH="$candidate:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1 || ! node_ok "$(command -v node)"; then
  echo "node 22.18+ (or 23.6+) is required, and none of the usual places had one"
  echo "(PATH, Homebrew, /usr/local, volta, nvm)."
  echo
  read -r -p "Press return to close. "
  exit 1
fi

# Am I an old copy of the file in the repo?
SOURCE="$VIEWER/deploy/desktop-launcher.command"
if [ -f "$SOURCE" ]; then
  source_rev="$(grep -m1 '^LAUNCHER_REV=' "$SOURCE" 2>/dev/null | cut -d= -f2)"
  if [ -n "$source_rev" ] && [ "$source_rev" != "$LAUNCHER_REV" ]; then
    echo "⚠️  This launcher is rev $LAUNCHER_REV; the repo now ships rev $source_rev."
    echo "    Copy it over (your knobs are at the top — re-apply any you changed):"
    echo "      cp \"$SOURCE\" \"$0\""
    echo
  fi
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

# The same promise for the plist's ENVIRONMENT. `agent.sh install` writes the
# whole EnvironmentVariables dict too, and two real settings live there rather
# than in the argv: PHASE_CONSOLE_DEFAULT_SKILLS (skills every run starts
# with) and PHASE_CONSOLE_NOTIFY (the out-of-band alert hook). Carrying the
# arguments but not these deleted a machine's default skills on the first
# knob-flip reinstall — same silent-loss shape, one dict further down. They
# are re-exported so agent.sh's own env fallbacks pick them up; anything ELSE
# found there is named on screen as NOT carried, never dropped in silence.
carried_env=()
uncarried_env=()
collect_carried_env() {
  [ -f "$PLIST" ] || return 0
  local key value
  while IFS=$'\t' read -r key value; do
    # Undo agent.sh's xml_escape, or a notify hook containing `&` would come
    # back as `&amp;` and be escaped AGAIN on the next install — drifting one
    # entity deeper per double-click. `&` last, so `&amp;lt;` cannot double-decode.
    value="$(printf '%s' "$value" | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g')"
    case "$key" in
      PATH|HOME|PHASE_CONSOLE_NO_OPEN) : ;;   # agent.sh always rewrites these
      PHASE_CONSOLE_NOTIFY|PHASE_CONSOLE_DEFAULT_SKILLS)
        export "$key=$value"
        carried_env+=("$key=$value") ;;
      *) uncarried_env+=("$key") ;;
    esac
  done < <(sed -n '/<key>EnvironmentVariables<\/key>/,/<\/dict>/p' "$PLIST" 2>/dev/null \
    | sed -n 's/.*<key>\([^<]*\)<\/key><string>\(.*\)<\/string>.*/\1\t\2/p')
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
  collect_carried_env

  echo "Phase Console — supervised by launchd ($LABEL)"
  banner
  { [ "${#carried[@]}" -gt 0 ] || [ "${#carried_env[@]}" -gt 0 ]; } && {
    echo "  keeping  ${carried[*]-}${carried[*]:+ }${carried_env[*]-}"
    echo "           (already in the plist, not managed here — kept on re-install)"
    echo
  }
  [ "${#uncarried_env[@]}" -gt 0 ] && {
    echo "  ⚠️  in the plist's environment but NOT carried by this launcher:"
    echo "      ${uncarried_env[*]}"
    echo "      A re-install from here would drop these — re-run agent.sh install"
    echo "      yourself with them exported if they matter."
    echo
  }

  # A console answering on the port is NOT evidence that the agent is running.
  # An earlier foreground console — including one this file started before it
  # grew a SUPERVISED knob — answers identically, holds the port, and is exactly
  # the unsupervised process whose Restart button refuses. Ask launchd what it
  # is actually running instead of inferring it from a healthy-looking port.
  # `print` first (authoritative), `list` as the fallback: print has been seen
  # answering non-zero transiently right around a kickstart window, and a false
  # "not loaded" here costs a harmless-but-noisy bootstrap of a loaded job.
  agent_loaded() {
    launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 \
      || launchctl list 2>/dev/null | grep -qF "$LABEL"
  }

  if ! agent_loaded && lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
    # launchd cannot bind a port something else holds: the job would crash-loop
    # on EADDRINUSE, and KeepAlive would keep it looping.
    echo "Port $PORT is held by a console launchd did not start:"
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print "  pid " $2 "  " $1}'
    echo
    echo "That is the unsupervised process the app refuses to restart. The agent"
    echo "cannot take the port until it stops."
    read -r -p "Stop it and hand the port to the agent? [y/N] " REPLY
    case "$REPLY" in
      y|Y|yes|YES)
        lsof -ti "tcp:$PORT" 2>/dev/null | xargs -r kill
        for _ in $(seq 1 20); do
          lsof -ti "tcp:$PORT" >/dev/null 2>&1 || break
          sleep 0.25
        done
        lsof -ti "tcp:$PORT" >/dev/null 2>&1 && lsof -ti "tcp:$PORT" | xargs -r kill -9
        echo "Stopped."
        echo
        ;;
      *)
        echo "Left it alone — opening it as it is. Restart will still refuse there."
        open_browser
        sleep 2
        exit 0
        ;;
    esac
  fi

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
  elif ! agent_loaded; then
    # The plist is right but nothing loaded it — after a `bootout`, or a plist
    # copied in by hand. Bootstrapping is enough; a re-install would rebuild the
    # client for no reason.
    echo "The plist is up to date but the job is not loaded — loading it…"
    launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null
    launchctl enable "gui/$UID/$LABEL" 2>/dev/null
    echo
  elif ! curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/api/state"; then
    # Loaded, matching, but silent. KeepAlive plus RunAtLoad means this is rare.
    echo "Loaded but not answering — asking launchd to restart it…"
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
