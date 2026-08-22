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
gate_approve(){ DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" "$SYS_BASH" "$PE_SCRIPTS/gate-approve.sh"       "$@"; }
# phase-outcome.sh needs no DOCS_ROOT — it writes $PE_OUTCOME_FILE, or (unsupervised)
# the console's inbox for the root it derives the way phase-lock.sh does.
pe_outcome()  {                                                "$SYS_BASH" "$PE_SCRIPTS/phase-outcome.sh"     "$@"; }
# session-hook.sh reads the hook payload on stdin; it needs no DOCS_ROOT either.
pe_hook()     {                                                "$SYS_BASH" "$PE_SCRIPTS/session-hook.sh"      "$@"; }
# PE_TODAY keeps closure dates off the wall clock so assertions stay stable.
pe_close()    { DOCS_ROOT="${DOCS_ROOT:?set DOCS_ROOT first}" PE_TODAY="${PE_TODAY:-2026-01-02}" \
                "$SYS_BASH" "$PE_SCRIPTS/close-plan.sh" "$@"; }

# --- the ambient session, scrubbed -------------------------------------------
# The scripts under test read PE_* from the environment BY DESIGN: a supervised
# session has PE_SCOPE/PE_OWNER/PE_SESSION_ID exported into it so phase-lock.sh
# records them without being told. That is also how this suite gets three false
# failures the moment it is run from inside such a session — a lock claimed with
# no --scope picks up the ambient one, and `lock-scope.bats` asserts a lock
# written WITHOUT a scope. The suite must describe the scripts, not the shell it
# happens to run in, so the ambient values are dropped here; a test that wants
# one sets it itself.
scrub_pe_env() {
  unset PE_SCOPE PE_OWNER PE_SESSION_ID PE_OUTCOME_FILE PE_RULINGS_FILE PE_MCP_SERVERS
}

# --- fixtures / scaffolding ---------------------------------------------------
# Create an isolated DOCS_ROOT in the bats temp dir and install a fixture plan.
# usage: setup_docs <fixture-name> <slug>
setup_docs() {
  local fixture="$1" slug="$2"
  scrub_pe_env
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
