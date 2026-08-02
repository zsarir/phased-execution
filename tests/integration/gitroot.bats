#!/usr/bin/env bats
# DOCS_ROOT resolution (F7/F13): resolve via git from a subdir; clear hint when
# there is no git repo and DOCS_ROOT is unset.
load ../helpers/test_helper

@test "resolves DOCS_ROOT via git from a nested subdirectory" {
  root="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$root/docs/plans" "$root/sub/deep"
  cp "$PE_DIR/tests/fixtures/plans/linear.md" "$root/docs/plans/demo.md"
  git -C "$root" init -q
  git -C "$root" config user.email t@t.t; git -C "$root" config user.name t
  run env -u DOCS_ROOT bash -c "cd '$root/sub/deep' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' demo --ready"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "not inside a git repo (DOCS_ROOT unset) gives a clear hint" {
  d="$BATS_TEST_TMPDIR/plain"; mkdir -p "$d"
  run env -u DOCS_ROOT bash -c "cd '$d' && /bin/bash '$PE_SCRIPTS/phase-graph.sh' nope --ready"
  [ "$status" -ne 0 ]
  assert_contains "$output" "not inside a git repo"
}
