#!/usr/bin/env bash
# Record a phase's QA result into docs/handoffs/<slug>/test-status.md — the source
# of truth the phased-execution engine reads to gate dependents. Deterministic, so
# the QA skill never hand-edits the table inconsistently (idempotent upsert).
#
# Usage: qa-record.sh <slug> <phase> <result> [--report REL_PATH] [--note TEXT]
#   result: pass | fail | waived | pending
set -euo pipefail
slug="${1:?usage: qa-record.sh <slug> <phase> <result> [--report PATH] [--note TEXT]}"
phase="${2:?phase number required}"
result="${3:?result required: pass|fail|waived|pending}"
shift 3
report="-"; note=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) report="${2:?--report needs a path}"; shift 2 ;;
    --note)   note="${2:?--note needs text}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$result" in pass|fail|waived|pending) : ;; *) echo "invalid result: $result (want pass|fail|waived|pending)" >&2; exit 2 ;; esac
case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac

if [ -z "${DOCS_ROOT:-}" ]; then
  DOCS_ROOT="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$DOCS_ROOT" ] || DOCS_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
dir="$DOCS_ROOT/docs/handoffs/$slug"
mkdir -p "$dir"
f="$dir/test-status.md"
if [ ! -f "$f" ]; then
  {
    printf '# QA / test status — %s\n\n' "$slug"
    printf 'Per-phase QA results recorded by phased-execution'\''s QA step. The engine reads the\n'
    printf '"Result" column to gate dependents: a phase is *verified* only when its handoff is\n'
    printf 'complete AND its Result is `pass` or `waived`. Values: pass | fail | pending | waived.\n\n'
    printf '## QA status\n\n| Phase | Result | Report |\n|------:|--------|--------|\n'
  } > "$f"
fi

# Upsert the row for this phase: replace in place if present, else append to the
# (contiguous, end-of-file) table.
tmp="$f.tmp.$$"
awk -v ph="$phase" -v res="$result" -v rep="$report" '
  function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
  BEGIN{ done=0 }
  {
    if ($0 ~ /^[[:space:]]*\|/) {
      n=split($0, c, "|"); cell=trim(c[2]); gsub(/[*`]/,"",cell)
      if (cell == ph) { printf "| %s | %s | %s |\n", ph, res, rep; done=1; next }
    }
    print
  }
  END{ if (!done) printf "| %s | %s | %s |\n", ph, res, rep }
' "$f" > "$tmp" && mv "$tmp" "$f"

echo "recorded: $slug phase $phase = $result  ->  $f"
[ -n "$note" ] && echo "  note: $note"
exit 0
