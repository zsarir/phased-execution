#!/usr/bin/env bash
# Common helpers for phased-execution bats tests.
#
# IMPORTANT: scripts under test are ALWAYS invoked under /bin/bash (macOS system
# bash 3.2) — the real target runtime — not the (possibly newer) bash that runs
# bats. This is what actually catches 3.2-specific regressions.

# Skill root, resolved from this helper's location: tests/helpers/ -> skill root.
PE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PE_SCRIPTS="$PE_DIR/scripts"
SYS_BASH="/bin/bash"

# --- runners (each forces the 3.2 system bash) --------------------------------
pg()          { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/phase-graph.sh"      "$@"; }
pe_validate() { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/validate.sh"          "$@"; }
pe_lock()     { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/phase-lock.sh"        "$@"; }
pe_newplan()  {                                                "$SYS_BASH" "$PE_SCRIPTS/new-plan.sh"          "$@"; }
pe_newho()    {                                                "$SYS_BASH" "$PE_SCRIPTS/new-handoff.sh"       "$@"; }
pe_nextp()    { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/next-phase-prompt.sh"  "$@"; }
pe_hostatus() { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/handoff-status.sh"     "$@"; }
qa_record()   { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/qa-record.sh"          "$@"; }
# PE_TODAY keeps closure dates off the wall clock so assertions stay stable.
pe_close()    { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" PE_TODAY="${PE_TODAY:-2026-01-02}" \
                "$SYS_BASH" "$PE_SCRIPTS/close-plan.sh" "$@"; }

# --- fixtures / scaffolding ---------------------------------------------------
# Create an isolated DOCS_ROOT in the bats temp dir and install a fixture plan.
# usage: setup_docs <fixture-name> <slug>
setup_docs() {
  local fixture="$1" slug="$2"
  export DOCS_ROOT="$BATS_TEST_TMPDIR/work"
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/$slug"
  cp "$PE_DIR/tests/fixtures/plans/$fixture.md" "$DOCS_ROOT/docs/plans/$slug.md"
}

# Write a minimal handoff with a given status for state tests.
# usage: write_handoff <slug> <N> <title> <status>   (status: complete|in-progress|blocked|pending)
write_handoff() {
  local slug="$1" n="$2" title="$3" status="$4" pad f
  pad="$(printf '%02d' "$n")"
  f="$DOCS_ROOT/docs/handoffs/$slug/phase-$pad-$title.md"
  mkdir -p "$(dirname "$f")"
  cat > "$f" <<EOF
---
plan: docs/plans/$slug.md
phase: $n
title: $title
status: $status
---
# Phase $n — $title
EOF
}

# Initialise a throwaway git repo as a DOCS_ROOT (for git-root / path tests).
# usage: setup_git_docs <fixture-name> <slug>   (leaves DOCS_ROOT UNSET on purpose)
setup_git_docs() {
  local fixture="$1" slug="$2" root="$BATS_TEST_TMPDIR/gitwork"
  mkdir -p "$root/docs/plans" "$root/docs/handoffs/$slug"
  cp "$PE_DIR/tests/fixtures/plans/$fixture.md" "$root/docs/plans/$slug.md"
  git -C "$root" init -q
  git -C "$root" config user.email t@t.t
  git -C "$root" config user.name t
  echo "$root"
}

# assert helpers
assert_contains() { case "$1" in *"$2"*) : ;; *) echo "expected to contain: $2" >&2; echo "actual: $1" >&2; return 1 ;; esac; }
refute_contains() { case "$1" in *"$2"*) echo "expected NOT to contain: $2" >&2; echo "actual: $1" >&2; return 1 ;; *) : ;; esac; }
