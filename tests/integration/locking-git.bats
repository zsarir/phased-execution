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

@test "a push that lost a race is rebased and pushed again, not dropped" {
  # The real collision once phases run concurrently: two sessions finish at the
  # same moment and both commit the same handoff folder from different clones.
  # The loser's push is rejected as non-fast-forward — a state that clears by
  # itself — so the lock has to rebase onto what landed and try again.
  origin="$BATS_TEST_TMPDIR/o3.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A3"; B="$BATS_TEST_TMPDIR/B3"

  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  git clone -q "$origin" "$B"
  git -C "$B" config user.email t@t.t; git -C "$B" config user.name b

  # B loses the race exactly once: a pre-push hook lands a commit from A first,
  # so B's first push is rejected and only the retry can succeed.
  mkdir -p "$B/.git/hooks"
  cat > "$B/.git/hooks/pre-push" <<EOF
#!/bin/sh
[ -f "$BATS_TEST_TMPDIR/raced" ] && exit 0
: > "$BATS_TEST_TMPDIR/raced"
env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE sh -c 'cd "$A" &&
  echo other >> notes.txt && git add notes.txt && git commit -qm other &&
  git push -q origin main' >/dev/null 2>&1
exit 0
EOF
  chmod +x "$B/.git/hooks/pre-push"

  run env DOCS_ROOT="$B" PE_GIT_RETRY_DELAY=0 /bin/bash \
    "$PE_SCRIPTS/phase-lock.sh" demo claim 2 --owner sessB --scope api-server --git
  [ "$status" -eq 0 ]
  assert_contains "$output" "git sync retry"

  # The lock survived the race: it is on origin, alongside A's commit.
  git -C "$A" pull -q --rebase
  [ -f "$A/docs/handoffs/demo/.locks/phase-02.lock" ]
  run grep '^scope=' "$A/docs/handoffs/demo/.locks/phase-02.lock"
  [ "$output" = "scope=api-server" ]
}

@test "a held index.lock never costs the caller its claim" {
  # git's own index.lock is the serialization for the docs repo — deliberately,
  # instead of making handoff commits part of a phase's scope. It has to be
  # survivable: publishing the lock is cooperative, holding it is not optional.
  origin="$BATS_TEST_TMPDIR/o4.git"
  git -c init.defaultBranch=main init -q --bare "$origin"
  A="$BATS_TEST_TMPDIR/A4"
  git clone -q "$origin" "$A"
  git -C "$A" config user.email t@t.t; git -C "$A" config user.name a
  mkdir -p "$A/docs/plans" "$A/docs/handoffs/demo"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$A/docs/plans/demo.md"
  git -C "$A" add -A; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main

  : > "$A/.git/index.lock"          # another git process is mid-write
  run env DOCS_ROOT="$A" PE_GIT_RETRIES=2 PE_GIT_RETRY_DELAY=0 /bin/bash \
    "$PE_SCRIPTS/phase-lock.sh" demo claim 2 --owner sessA --scope api-server --git
  rm -f "$A/.git/index.lock"

  [ "$status" -eq 0 ]                                             # the claim held
  assert_contains "$output" "git sync retry"                      # and it did retry
  [ -f "$A/docs/handoffs/demo/.locks/phase-02.lock" ]             # on disk regardless
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
