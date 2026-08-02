#!/usr/bin/env bash
# Scaffold docs/plans/<slug>.md from the skill template.
# Usage: new-plan.sh <slug>     (run from the repo root that owns docs/, or set DOCS_ROOT)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
slug="${1:?usage: new-plan.sh <slug>}"

# ---------------------------------------------------------------------------
# Resolve DOCS_ROOT: superproject-aware (handles submodule cwd).
# ---------------------------------------------------------------------------
_resolve_root() {
  [ -n "${DOCS_ROOT:-}" ] && { printf '%s' "$DOCS_ROOT"; return; }
  local r
  r="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$r" ] && { printf '%s' "$r"; return; }
  git rev-parse --show-toplevel 2>/dev/null || pwd
}
DOCS_ROOT="$(_resolve_root)"
if [ ! -d "$DOCS_ROOT/docs" ]; then
  printf 'ERROR: docs/ not found under DOCS_ROOT=%s\n' "$DOCS_ROOT" >&2
  printf '  → run from the repo root, or: DOCS_ROOT=/path/to/repo %s ...\n' "$(basename "$0")" >&2
  exit 1
fi

dest="$DOCS_ROOT/docs/plans/${slug}.md"
mkdir -p "$DOCS_ROOT/docs/plans"
if [ -e "$dest" ]; then
  echo "refusing to overwrite existing plan: $dest" >&2
  exit 1
fi

date_str="$(date +%F)"
sed -e "s|{{SLUG}}|${slug}|g" -e "s|{{DATE}}|${date_str}|g" \
  "$SKILL_DIR/templates/plan.md" > "$dest"

echo "created $dest"
