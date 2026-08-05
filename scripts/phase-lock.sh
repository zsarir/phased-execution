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
# A lock also records the SCOPE of the phase — the repos it touches, from the
# plan's Repos column. Sessions on disjoint scopes cannot collide, so they may
# run at the same time; `conflicts` is the read-only question "would my scope hit
# any live lock, in ANY plan?". Claiming deliberately does NOT enforce scope: it
# still refuses only the same phase of the same plan, so an old console and an
# old script keep working. The policy lives where the answer can be acted on.
#
# Usage:
#   phase-lock.sh <slug> claim   <N> [--owner ID] [--lease SECS] [--scope CSV] [--git] [--force]
#   phase-lock.sh <slug> release <N> [--owner ID] [--git] [--force]
#   phase-lock.sh <slug> status  <N>
#   phase-lock.sh <slug> list
#   phase-lock.sh <slug> conflicts [N] [--scope CSV] [--owner ID] [--git]
#
# Owner defaults to "$PE_OWNER" or "<user>@<host>". Pass a per-SESSION --owner
# (e.g. "account/conversation-id") so two sessions on the same host are distinct.
# Scope defaults to "$PE_SCOPE", else the plan's Repos cell for the phase.
#
# Exit: 0 = ok / claimed / refreshed / taken-over / free / released / no conflict;
#       1 = held by another live session, or scope conflicts;  2 = usage error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/scope.sh"

slug="${1:?usage: phase-lock.sh <slug> <claim|release|status|list|conflicts> [N] [opts]}"
action="${2:?usage: phase-lock.sh <slug> <claim|release|status|list|conflicts> [N] [opts]}"
shift 2

phase=""
case "$action" in
  claim|release|status)
    phase="${1:?usage: phase-lock.sh <slug> $action <N> ...}"; shift
    case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
    ;;
  conflicts)
    # The phase is optional here: asking "does this scope collide with anything
    # live?" is a fair question before you know which phase you will take.
    if [ $# -gt 0 ]; then
      case "$1" in [0-9]*) phase="$1"; shift ;; esac
    fi
    ;;
  list) : ;;
  *) echo "unknown action: $action (want claim|release|status|list|conflicts)" >&2; exit 2 ;;
esac

owner="${PE_OWNER:-$(id -un)@$(hostname -s 2>/dev/null || hostname)}"
lease=1800        # default lease: 30 min
scope="${PE_SCOPE:-}"
use_git=0
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) owner="${2:?--owner needs a value}"; shift 2 ;;
    --lease) lease="${2:?--lease needs seconds}"; shift 2 ;;
    --scope) scope="${2:?--scope needs a csv}"; shift 2 ;;
    --git)   use_git=1; shift ;;
    --force) force=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
scope="$(scope_normalize "$scope")"

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
    # Only when stated. An absent scope reads as "unknown" — which every reader
    # treats as colliding — and that is the right meaning for a lock written by
    # an older copy of this script.
    [ -n "$scope" ] && printf 'scope=%s\n' "$scope"
  } > "$tmp"
  mv "$tmp" "$lockfile"
}
_git_pull() { [ "$use_git" = 1 ] && git -C "$DOCS_ROOT" pull --rebase --autostash >/dev/null 2>&1 || true; }
# Two sessions finishing phases at the same moment write the same handoff folder
# from different clones, and git says so: a held index.lock, or a push rejected
# because the other one landed first. Both clear by themselves — so rebase onto
# what landed and try again rather than losing the lock commit. Never fatal: a
# lock that failed to publish is a cooperative miss, not a reason to abort the
# claim the caller already has on disk.
_git_retries="${PE_GIT_RETRIES:-3}"
_git_retry_delay="${PE_GIT_RETRY_DELAY:-2}"
_git_sync() {  # _git_sync <verb>
  [ "$use_git" = 1 ] || return 0
  local attempt=1
  while :; do
    # Commit only when something is staged: after a rejected push the commit is
    # already made, and re-running it would fail with "nothing to commit" and
    # break the chain before the retry ever reached the push — which is the
    # whole point of retrying.
    if ( cd "$DOCS_ROOT" \
           && git add "docs/handoffs/$slug/.locks" >/dev/null 2>&1 \
           && { git diff --cached --quiet -- "docs/handoffs/$slug/.locks" \
                || git commit -m "phase-lock: $1 phase $phase ($slug) by $owner" >/dev/null 2>&1; } \
           && git push >/dev/null 2>&1 ); then
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le "$_git_retries" ] || return 0
    printf 'phase-lock: git sync retry %s/%s (%s)\n' "$attempt" "$_git_retries" "$1" >&2
    _git_pull
    [ "$_git_retry_delay" = 0 ] || sleep "$_git_retry_delay"
  done
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
      rm -f "$lockfile"
      # Releasing the LAST lock of a slug that has no handoffs must not leave
      # an empty husk under docs/handoffs/ — a folder with no files and an
      # empty .locks/ reads as an orphan that exists for no reason (the
      # viewer's store test rightly objects; one such husk was found live).
      # Best-effort only: rmdir refuses non-empty directories, which is
      # exactly the guard wanted here.
      rmdir "$lockdir" 2>/dev/null || true
      rmdir "$DOCS_ROOT/docs/handoffs/$slug" 2>/dev/null || true
      _git_sync release
      printf 'phase %s: released\n' "$phase"; exit 0
    fi
    printf 'phase %s: held by %s, not %s — use --force to override\n' "$phase" "$cur_owner" "$owner" >&2
    exit 1
    ;;
  status)
    if [ ! -f "$lockfile" ]; then printf 'phase %s: free\n' "$phase"; exit 0; fi
    cur_owner="$(_field owner)"; cur_lease="$(_field lease_until)"; cur_at="$(_field claimed_at)"
    cur_scope="$(_field scope)"
    exp=""; [ -n "$cur_lease" ] && [ "$now" -ge "$cur_lease" ] && exp=" (EXPIRED — free to take over)"
    sc=""; [ -n "$cur_scope" ] && sc=" [scope: $cur_scope]"
    printf 'phase %s: held by %s since %s, lease until %s%s%s\n' \
      "$phase" "$cur_owner" "$(_fmt "$cur_at")" "$(_fmt "$cur_lease")" "$exp" "$sc"
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
      s="$(grep -m1 '^scope=' "$f" | sed 's/^scope=//' || true)"
      exp=""; [ -n "$l" ] && [ "$now" -ge "$l" ] && exp=" (expired)"
      sc=""; [ -n "$s" ] && sc=" [scope: $s]"
      printf 'phase %s: %s until %s%s%s\n' "$p" "$o" "$(_fmt "$l")" "$exp" "$sc"
    done
    [ "$found" = 0 ] && printf 'no active locks for %s\n' "$slug"
    exit 0
    ;;
  conflicts)
    # Read-only, and deliberately across ALL plans: the thing that makes two
    # sessions unsafe is a shared working tree, and working trees do not know
    # which plan asked for them.
    _git_pull
    if [ -z "$scope" ] && [ -n "$phase" ]; then
      scope="$("$SCRIPT_DIR/phase-graph.sh" "$slug" --repos "$phase" 2>/dev/null || true)"
      scope="$(scope_normalize "$scope")"
    fi
    if [ -z "$scope" ]; then
      printf 'usage: phase-lock.sh %s conflicts [N] --scope "<csv>"\n' "$slug" >&2
      printf '  (no --scope, no $PE_SCOPE, and no phase to read the plan Repos cell from)\n' >&2
      exit 2
    fi
    hits=0
    for f in "$DOCS_ROOT"/docs/handoffs/*/.locks/phase-*.lock; do
      [ -e "$f" ] || continue
      o="$(grep -m1 '^owner=' "$f" | sed 's/^owner=//' || true)"
      l="$(grep -m1 '^lease_until=' "$f" | sed 's/^lease_until=//' || true)"
      p="$(grep -m1 '^phase=' "$f" | sed 's/^phase=//' || true)"
      s="$(grep -m1 '^slug=' "$f" | sed 's/^slug=//' || true)"
      sc="$(grep -m1 '^scope=' "$f" | sed 's/^scope=//' || true)"
      [ -n "$l" ] && [ "$now" -ge "$l" ] && continue      # expired: free to take
      [ "$o" = "$owner" ] && continue                      # our own session
      # A closed plan has no live sessions by definition, so a lock it left behind is
      # debris — and because this scan crosses every plan, that debris would otherwise
      # block work on unrelated plans until its lease happened to lapse.
      [ -n "$s" ] && bash "$SCRIPT_DIR/phase-graph.sh" "$s" --closed >/dev/null 2>&1 && continue
      scope_intersects "$scope" "$sc" || continue
      hits=$((hits + 1))
      overlap="$(scope_overlap "$scope" "$sc")"
      [ -n "$sc" ] || sc="unstated"
      [ -n "$overlap" ] || overlap="unstated"
      printf 'CONFLICT %s phase %s — held by %s until %s [scope: %s] overlaps: %s\n' \
        "${s:-?}" "${p:-?}" "${o:-?}" "$(_fmt "$l")" "$sc" "$overlap"
    done
    if [ "$hits" = 0 ]; then
      printf 'no scope conflicts for [%s] — safe to start\n' "$scope"
      exit 0
    fi
    printf '  → %s live session(s) share a working tree with [%s].\n' "$hits" "$scope" >&2
    printf '    Stop and ask: wait for them, take a phase with a disjoint scope, or (if you know\n' >&2
    printf '    that session is dead) --force the claim.\n' >&2
    exit 1
    ;;
esac
