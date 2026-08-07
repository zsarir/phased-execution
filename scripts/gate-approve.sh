#!/usr/bin/env bash
# Record (or revoke) a phase-gate approval in docs/handoffs/<slug>/gate-status.md —
# the clearance record scripts/phase-graph.sh --gate-status reads. An approved row
# clears a gate of ANY kind (human, ai, auto): it is the operator's override from
# the console's Gate card, or an AI session's recorded evidence that it verified
# and did the gate work itself. Deterministic upsert so the console and sessions
# never hand-edit the table inconsistently (idempotent, atomic tmp+mv, no git —
# the caller commits).
#
# A separate file from test-status.md ON PURPOSE: that file's existence switches
# QA gating on, and approving a gate must never flip an unrelated regime.
#
# Usage: gate-approve.sh <slug> <phase> [--by WHO] [--note TEXT] [--revoke]
set -euo pipefail
slug="${1:?usage: gate-approve.sh <slug> <phase> [--by WHO] [--note TEXT] [--revoke]}"
phase="${2:?phase number required}"
shift 2
by=""; note="-"; verdict="yes"
while [ $# -gt 0 ]; do
  case "$1" in
    --by)     by="${2:?--by needs a name}"; shift 2 ;;
    --note)   note="${2:?--note needs text}"; shift 2 ;;
    --revoke) verdict="revoked"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac

# Who cleared it. Defaults to the autopilot's exported owner, else user@host —
# the same identity phase-lock.sh records, so the two artifacts read alike.
[ -n "$by" ] || by="${PE_OWNER:-$(whoami 2>/dev/null || echo operator)@$(hostname -s 2>/dev/null || hostname)}"
# Table cells: one line, no pipes, bounded.
by="$(printf '%s' "$by" | tr -d '|' | tr '\r\n\t' '   ' | cut -c1-64)"
note="$(printf '%s' "$note" | tr '\r\n\t|' '    ' | sed 's/  */ /g; s/^ //; s/ *$//' | cut -c1-200)"
[ -n "$note" ] || note="-"
# PE_TODAY keeps test assertions off the wall clock (close-plan.sh precedent).
today="${PE_TODAY:-$(date +%F)}"

if [ -z "${DOCS_ROOT:-}" ]; then
  DOCS_ROOT="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$DOCS_ROOT" ] || DOCS_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
dir="$DOCS_ROOT/docs/handoffs/$slug"
mkdir -p "$dir"
f="$dir/gate-status.md"
if [ ! -f "$f" ]; then
  {
    printf '# Gate approvals — %s\n\n' "$slug"
    printf 'Per-phase gate clearances recorded by phased-execution'\''s gate step (the console'\''s\n'
    printf 'Gate card, an AI session that verified the conditions, or gate-approve.sh by hand).\n'
    printf 'The engine reads the "Approved" column: a `yes` row clears that phase'\''s gate —\n'
    printf 'every kind — so the phase can start; `revoked` restores the gate. This is NOT the\n'
    printf 'QA table: it deliberately lives apart from test-status.md, whose very existence\n'
    printf 'switches QA gating on.\n\n'
    printf '## Gate approvals\n\n| Phase | Approved | By | Date | Note |\n|------:|----------|----|------|------|\n'
  } > "$f"
fi

# Upsert the row for this phase: replace in place if present, else append to the
# (contiguous, end-of-file) table.
tmp="$f.tmp.$$"
awk -v ph="$phase" -v v="$verdict" -v who="$by" -v d="$today" -v note="$note" '
  function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
  BEGIN{ done=0 }
  {
    if ($0 ~ /^[[:space:]]*\|/) {
      n=split($0, c, "|"); cell=trim(c[2]); gsub(/[*`]/,"",cell)
      if (cell == ph) { printf "| %s | %s | %s | %s | %s |\n", ph, v, who, d, note; done=1; next }
    }
    print
  }
  END{ if (!done) printf "| %s | %s | %s | %s | %s |\n", ph, v, who, d, note }
' "$f" > "$tmp" && mv "$tmp" "$f"

if [ "$verdict" = yes ]; then
  echo "approved: $slug phase $phase by $by on $today  ->  $f"
else
  echo "revoked: $slug phase $phase by $by on $today  ->  $f"
fi
exit 0
