#!/usr/bin/env bash
# Cooperative phase locking for phased-execution — the concurrency guard.
#
# A lock is a small file at docs/handoffs/<slug>/.locks/phase-NN.lock recording
# WHO is working a phase and a LEASE (expiry time). It lets a second session
# detect that another session already holds a phase and decide what to do, rather
# than two sessions silently building the same phase on top of each other.
#
# Cross-account / cross-machine: locks live in the project repo (work/docs), so
# pass --git to `git pull` before checking and commit+push the lock after
# claiming; other clones see it on their next pull. This is COOPERATIVE (relies on
# pull-before-claim), not a hard distributed mutex — on a real conflict it asks a
# human to decide.
#
# Usage:
#   phase-lock.sh <slug> claim   <N> [--owner ID] [--lease SECS] [--git] [--force]
#   phase-lock.sh <slug> release <N> [--owner ID] [--git] [--force]
#   phase-lock.sh <slug> status  <N>
#   phase-lock.sh <slug> list
#
# Owner defaults to "$PE_OWNER" or "<user>@<host>". Pass a per-SESSION --owner
# (e.g. "account/conversation-id") so two sessions on the same host are distinct.
#
# Exit: 0 = ok / claimed / refreshed / taken-over / free / released;
#       1 = held by another live session;  2 = usage error.
set -euo pipefail

slug="${1:?usage: phase-lock.sh <slug> <claim|release|status|list> [N] [opts]}"
action="${2:?usage: phase-lock.sh <slug> <claim|release|status|list> [N] [opts]}"
shift 2

phase=""
case "$action" in
  claim|release|status)
    phase="${1:?usage: phase-lock.sh <slug> $action <N> ...}"; shift
    case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
    ;;
  list) : ;;
  *) echo "unknown action: $action (want claim|release|status|list)" >&2; exit 2 ;;
esac

owner="${PE_OWNER:-$(id -un)@$(hostname -s 2>/dev/null || hostname)}"
lease=1800        # default lease: 30 min
use_git=0
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) owner="${2:?--owner needs a value}"; shift 2 ;;
    --lease) lease="${2:?--lease needs seconds}"; shift 2 ;;
    --git)   use_git=1; shift ;;
    --force) force=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "${DOCS_ROOT:-}" ]; then
  DOCS_ROOT="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$DOCS_ROOT" ] || DOCS_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
lockdir="$DOCS_ROOT/docs/handoffs/$slug/.locks"
pad=""; [ -n "$phase" ] && pad="$(printf '%02d' "$phase")"
lockfile="$lockdir/phase-$pad.lock"
now="$(date +%s)"

_field()  { grep -m1 "^$1=" "$lockfile" 2>/dev/null | sed "s/^$1=//" || true; }
_fmt()    { [ -z "${1:-}" ] && { printf '?'; return; }; date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null || printf '%s' "$1"; }
_write()  {
  mkdir -p "$lockdir"
  local tmp="$lockfile.tmp.$$"
  {
    printf 'slug=%s\n'        "$slug"
    printf 'phase=%s\n'       "$phase"
    printf 'owner=%s\n'       "$owner"
    printf 'host=%s\n'        "$(hostname -s 2>/dev/null || hostname)"
    printf 'claimed_at=%s\n'  "$now"
    printf 'lease_until=%s\n' "$((now + lease))"
  } > "$tmp"
  mv "$tmp" "$lockfile"
}
_git_pull() { [ "$use_git" = 1 ] && git -C "$DOCS_ROOT" pull --rebase --autostash >/dev/null 2>&1 || true; }
_git_sync() {  # _git_sync <verb>
  [ "$use_git" = 1 ] || return 0
  ( cd "$DOCS_ROOT" \
      && git add "docs/handoffs/$slug/.locks" >/dev/null 2>&1 \
      && git commit -m "phase-lock: $1 phase $phase ($slug) by $owner" >/dev/null 2>&1 \
      && git push >/dev/null 2>&1 ) || true
}

case "$action" in
  claim)
    _git_pull
    if [ -f "$lockfile" ]; then
      cur_owner="$(_field owner)"; cur_lease="$(_field lease_until)"
      if [ "$cur_owner" = "$owner" ]; then
        _write; _git_sync refresh
        printf 'phase %s: lock refreshed for %s (lease %ss)\n' "$phase" "$owner" "$lease"; exit 0
      fi
      if [ -n "$cur_lease" ] && [ "$now" -ge "$cur_lease" ]; then
        _write; _git_sync takeover
        printf 'phase %s: takeover — previous lease (held by %s) had expired\n' "$phase" "$cur_owner"; exit 0
      fi
      if [ "$force" = 1 ]; then
        _write; _git_sync force
        printf 'phase %s: force-claimed from %s\n' "$phase" "$cur_owner"; exit 0
      fi
      printf 'phase %s is being worked by %s (lease until %s).\n' "$phase" "$cur_owner" "$(_fmt "$cur_lease")" >&2
      printf '  → stop that session, re-run with --force to take over, or start another ready phase.\n' >&2
      exit 1
    fi
    _write; _git_sync claim
    printf 'phase %s: claimed by %s (lease %ss)\n' "$phase" "$owner" "$lease"; exit 0
    ;;
  release)
    _git_pull
    if [ ! -f "$lockfile" ]; then printf 'phase %s: already free\n' "$phase"; exit 0; fi
    cur_owner="$(_field owner)"
    if [ "$cur_owner" = "$owner" ] || [ "$force" = 1 ]; then
      rm -f "$lockfile"; _git_sync release
      printf 'phase %s: released\n' "$phase"; exit 0
    fi
    printf 'phase %s: held by %s, not %s — use --force to override\n' "$phase" "$cur_owner" "$owner" >&2
    exit 1
    ;;
  status)
    if [ ! -f "$lockfile" ]; then printf 'phase %s: free\n' "$phase"; exit 0; fi
    cur_owner="$(_field owner)"; cur_lease="$(_field lease_until)"; cur_at="$(_field claimed_at)"
    exp=""; [ -n "$cur_lease" ] && [ "$now" -ge "$cur_lease" ] && exp=" (EXPIRED — free to take over)"
    printf 'phase %s: held by %s since %s, lease until %s%s\n' \
      "$phase" "$cur_owner" "$(_fmt "$cur_at")" "$(_fmt "$cur_lease")" "$exp"
    exit 0
    ;;
  list)
    if [ ! -d "$lockdir" ]; then printf 'no active locks for %s\n' "$slug"; exit 0; fi
    found=0
    for f in "$lockdir"/phase-*.lock; do
      [ -e "$f" ] || continue
      found=1
      o="$(grep -m1 '^owner=' "$f" | sed 's/^owner=//')"
      l="$(grep -m1 '^lease_until=' "$f" | sed 's/^lease_until=//')"
      p="$(grep -m1 '^phase=' "$f" | sed 's/^phase=//')"
      exp=""; [ -n "$l" ] && [ "$now" -ge "$l" ] && exp=" (expired)"
      printf 'phase %s: %s until %s%s\n' "$p" "$o" "$(_fmt "$l")" "$exp"
    done
    [ "$found" = 0 ] && printf 'no active locks for %s\n' "$slug"
    exit 0
    ;;
esac
