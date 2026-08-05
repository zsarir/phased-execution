#!/usr/bin/env bash
# Close a plan — or reopen one.
#
# Progress is computed and never stored: `phase-graph.sh` derives done/ready/waiting
# from the handoffs, and no amount of reading them can answer "does anyone still care
# about this plan?". That is an operator decision, so it is the one piece of plan state
# that IS stored — in the plan's own `status:` frontmatter.
#
# A terminal status (complete | abandoned | superseded) means the plan is CLOSED: it
# stops reporting stuck handoffs, QA failures, drift warnings, ready phases, boot
# prompts, batching and notifications. Its board still renders in full and genuine
# structural damage is still reported as a note — closing quiets a plan, it never
# hides or deletes one, and `--reopen` reverses it.
#
# Usage:
#   close-plan.sh <slug> [--status abandoned|superseded|complete] [--reason "TEXT"] [--force]
#   close-plan.sh <slug> --reopen
#
# Writes only the plan file (and releases that plan's own phase locks). Never runs git.
set -euo pipefail

slug="${1:?usage: close-plan.sh <slug> [--status abandoned|superseded|complete] [--reason TEXT] [--reopen] [--force]}"
shift

status="abandoned"; reason=""; reopen=0; force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --status) status="$(printf '%s' "${2:?--status needs a value}" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
    --reason) reason="${2:?--reason needs text}"; shift 2 ;;
    --reopen) reopen=1; shift ;;
    --force)  force=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$reopen" = 1 ]; then
  case "$status:$reason" in
    abandoned:) : ;;
    *) echo "--reopen takes no --status or --reason" >&2; exit 2 ;;
  esac
else
  case "$status" in
    complete|abandoned|superseded) : ;;
    active) echo "active is not a closed status — use --reopen to reopen a plan" >&2; exit 2 ;;
    *) echo "invalid status: $status (want complete|abandoned|superseded)" >&2; exit 2 ;;
  esac
fi

if [ -z "${DOCS_ROOT:-}" ]; then
  DOCS_ROOT="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$DOCS_ROOT" ] || DOCS_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
plan_file="$DOCS_ROOT/docs/plans/${slug}.md"
[ -f "$plan_file" ] || { echo "no such plan: $plan_file" >&2; exit 2; }
head -1 "$plan_file" | grep -q '^---[[:space:]]*$' \
  || { echo "plan has no frontmatter block: $plan_file" >&2; exit 2; }

# One line, no comment marker (every reader strips `# ...` as a legend), no runaway
# length — a reason is a sentence, not a changelog.
reason="$(printf '%s' "$reason" | tr '\n\r\t' '   ' | tr -d '#' | sed 's/  */ /g; s/^ //; s/ $//' | cut -c1-200)"
if [ "$reopen" = 0 ] && [ -z "$reason" ] && [ "$force" = 0 ]; then
  echo "refusing to close $slug without --reason (or pass --force)" >&2
  exit 2
fi

# PE_TODAY keeps the tests off the wall clock.
day="${PE_TODAY:-$(date +%Y-%m-%d)}"

tmp="$plan_file.tmp.$$"
awk -v st="$status" -v day="$day" -v reason="$reason" -v reopen="$reopen" '
  BEGIN { infm = 0; seen = 0 }
  NR == 1 && /^---[[:space:]]*$/ { print; infm = 1; next }
  infm && /^---[[:space:]]*$/ {
    if (!seen) print (reopen ? "status: active" : "status: " st)
    if (!reopen) {
      printf "closed: %s\n", day
      if (reason != "") printf "closed_reason: %s\n", reason
    }
    print; infm = 0; next
  }
  infm && /^status:/ { print (reopen ? "status: active" : "status: " st); seen = 1; next }
  infm && /^closed:/ { next }
  infm && /^closed_reason:/ { next }
  { print }
' "$plan_file" > "$tmp" && mv "$tmp" "$plan_file"

# A closed plan must never gate live work: `phase-lock.sh conflicts` scans every plan,
# so a dead plan's leftover lock would keep colliding with sessions on other plans.
released=0
lock_dir="$DOCS_ROOT/docs/handoffs/$slug/.locks"
if [ "$reopen" = 0 ] && [ -d "$lock_dir" ]; then
  for lock in "$lock_dir"/phase-*.lock; do
    [ -e "$lock" ] || continue
    rm -f "$lock"
    released=$((released + 1))
  done
  rmdir "$lock_dir" 2>/dev/null || true
fi

if [ "$reopen" = 1 ]; then
  echo "reopened: $slug is active again  ->  $plan_file"
else
  echo "closed: $slug = $status ($day)  ->  $plan_file"
  [ -n "$reason" ] && echo "  reason: $reason"
  [ "$released" -gt 0 ] && echo "  released $released phase lock(s) held by this plan"
fi
exit 0
