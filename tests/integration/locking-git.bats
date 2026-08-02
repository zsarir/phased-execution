#!/usr/bin/env bats
# Git-synced phase locks: a claim committed+pushed by one clone is seen by another
# clone after pull, so a second session is correctly refused (cross-account guard).
load ../helpers/test_helper

@test "a --git lock claimed in clone A is seen by clone B and refuses its claim" {
  origin="$BATS_TEST_TMPDIR/origin.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A"; B="$BATS_TEST_TMPDIR/B"

  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/diamond.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  git clone -q "$origin" "$B"
  git -C "$B" config user.email t@t.t; git -C "$B" config user.name b

  # Session A claims phase 1 and pushes the lock.
  env DOCS_ROOT="$A" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessA --git
  [ -f "$A/docs/handoffs/demo/.locks/phase-01.lock" ]

  # Session B (a different clone) pulls and is refused, told who holds it.
  run env DOCS_ROOT="$B" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessB --git
  [ "$status" -ne 0 ]
  assert_contains "$output" "sessA"
  [ -f "$B/docs/handoffs/demo/.locks/phase-01.lock" ]   # the lock arrived via pull
}

@test "same session re-claim across a pull is idempotent" {
  origin="$BATS_TEST_TMPDIR/o2.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A2"
  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/diamond.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  env DOCS_ROOT="$A" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessA --git
  run env DOCS_ROOT="$A" /bin/bash "$PE_SCRIPTS/phase-lock.sh" demo claim 1 --owner sessA --git
  [ "$status" -eq 0 ]
  assert_contains "$output" "refreshed"
}
