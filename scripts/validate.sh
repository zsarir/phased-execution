#!/usr/bin/env bash
# Deterministic validator for a phased-execution plan + its handoffs.
#   F1/F2/F3 : structural lint of the plan (delegated to phase-graph.sh --lint).
#   F10      : handoff body + consistency checks — valid status, required
#              sections present, and depends_on agreeing with the plan graph.
#
# Usage: validate.sh <slug>     (run from the repo root, or set DOCS_ROOT)
# Exit 0 = valid, non-zero = problems (printed to stderr).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
slug="${1:?usage: validate.sh <slug>}"
if [ -z "${DOCS_ROOT:-}" ]; then
  DOCS_ROOT="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$DOCS_ROOT" ] || DOCS_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
BASH_BIN="${BASH:-bash}"

# 0) Closed plans are not validated. Validation exists to keep work runnable, and a
# closed plan has no work; without this, an abandoned plan flunks its handoff checks
# forever and there is no way to make it stop short of finishing what was abandoned.
# Ask the engine rather than re-reading frontmatter — closure is defined in one place.
if closed="$("$BASH_BIN" "$SCRIPT_DIR/phase-graph.sh" "$slug" --closed 2>/dev/null)"; then
  echo "VALIDATE SKIPPED (${closed#closed }): $slug is closed — reopen it to validate again"
  exit 0
fi

# 1) Structural lint of the plan (aborts here on F1/F2/F3 via the engine's exit code).
"$BASH_BIN" "$SCRIPT_DIR/phase-graph.sh" "$slug" --lint

# 2) Handoff body + consistency checks (F10).
ho_dir="$DOCS_ROOT/docs/handoffs/$slug"
problems=0
if [ -d "$ho_dir" ]; then
  for f in "$ho_dir"/phase-*.md; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"

    st="$(grep -m1 '^status:' "$f" | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
    case "$st" in
      complete|in-progress|blocked|pending) : ;;
      *) echo "  ✗ $base: invalid/missing status: '${st:-(none)}'" >&2; problems=$((problems + 1)) ;;
    esac

    # The handoff must be actionable: it needs the boot section (the next phase(s)
    # prompts, or the final closeout). Prose section NAMES vary legitimately across
    # handoffs, so don't enforce them rigidly — bootstrap-ability is the contract.
    grep -qiE 'start next phase|final phase|closeout' "$f" \
      || { echo "  ✗ $base: missing the '▶ Start next phase(s)' boot section" >&2; problems=$((problems + 1)); }

    phnum="$(grep -m1 '^phase:' "$f" | sed 's/^phase:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
    if [ -n "$phnum" ]; then
      # `|| true` on both: under `set -eo pipefail`, a handoff with NO
      # depends_on line made grep fail the pipeline and killed this validator
      # mid-loop — exit 1 with no ✗ and no summary, the exact silent-red shape
      # this script exists to prevent. A missing line must be REPORTED as a
      # disagreement, not die unexplained.
      want="$("$BASH_BIN" "$SCRIPT_DIR/phase-graph.sh" "$slug" --deps "$phnum" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -n | tr '\n' ' ' | sed 's/ *$//' || true)"
      got="$(grep -m1 '^depends_on:' "$f" | sed 's/^depends_on:[[:space:]]*\[//; s/\].*$//; s/,/ /g' | tr '\n' ' ' | tr -s ' ' | tr ' ' '\n' | sed '/^$/d' | sort -n | tr '\n' ' ' | sed 's/ *$//' || true)"
      [ "$want" = "$got" ] || { echo "  ✗ $base: depends_on [$got] disagrees with plan graph [$want]" >&2; problems=$((problems + 1)); }
    fi
  done
fi

if [ "$problems" -gt 0 ]; then
  echo "VALIDATE FAIL: $slug — $problems handoff problem(s)" >&2
  exit 1
fi
echo "VALIDATE OK: $slug"
