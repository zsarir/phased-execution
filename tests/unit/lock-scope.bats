#!/usr/bin/env bats
# Scope: what a phase touches, and whether a second session may run beside it.
#
# The old rule serialised everything, so a lock only had to answer "is this
# phase taken?". The new rule needs "does anything live share my working tree?",
# across ALL plans — a session in another plan holding the same repo is exactly
# the collision that matters. These tests pin the contract the console's
# scheduler is built on: exit 0 clear / 1 conflicts / 2 usage.
load ../helpers/test_helper

# --- the Repos column, read by the engine -------------------------------------

@test "scope: --repos normalises the Repos cell of every shape" {
  setup_docs scoped scoped
  run pg scoped --repos 1; [ "$output" = "api-server" ]        # `backticks`
  run pg scoped --repos 3; [ "$output" = "web-app" ]           # **bold**
  run pg scoped --repos 4; [ "$output" = "api-server,docs" ]   # comma list
  run pg scoped --repos 6; [ "$output" = "packages/cart-api" ] # aside dropped, path kept
}

@test "scope: a phase that declares no repos reads as all" {
  setup_docs scoped scoped
  run pg scoped --repos 5
  [ "$status" -eq 0 ]
  # Saying nothing must never read as "collides with nothing".
  [ "$output" = "all" ]
}

@test "scope: --repos without a phase is a usage error" {
  setup_docs scoped scoped
  run pg scoped --repos
  [ "$status" -eq 2 ]
}

@test "scope: a prose bullet mentioning scope is not a scope declaration" {
  # Real plans write "- **Scope change — X moved to Phase 4:** <prose>" inside a
  # phase block. An override keyed on that label read the prose as repo tokens —
  # the exact "missed conflict" failure this whole mechanism exists to prevent.
  # The Repos column is the only declaration; nothing in the body overrides it.
  setup_docs scoped scoped
  perl -0pi -e 's/(### Phase 2 — Api\n)/$1- **Scope change — moved to Phase 4:** a long prose sentence\n/' \
    "$DOCS_ROOT/docs/plans/scoped.md"
  run pg scoped --repos 2; [ "$output" = "api-server" ]
}

# --- the lock file ------------------------------------------------------------

@test "scope: claim --scope writes a scope= line" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server, docs"
  run grep '^scope=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock"
  [ "$status" -eq 0 ]
  [ "$output" = "scope=api-server,docs" ]
}

@test "scope: PE_SCOPE supplies the scope when --scope is absent" {
  setup_docs scoped scoped
  PE_SCOPE="web-app" pe_lock scoped claim 3 --owner sessionA
  run grep '^scope=' "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-03.lock"
  [ "$output" = "scope=web-app" ]
}

@test "scope: status and list show the scope" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped status 2
  assert_contains "$output" "scope: api-server"
  run pe_lock scoped list
  assert_contains "$output" "scope: api-server"
}

@test "scope: a lock written without one still parses (old format)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA
  refute_contains "$(cat "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock")" "scope="
  run pe_lock scoped status 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "sessionA"
  # And claiming still refuses the same phase — the old guard is untouched.
  run pe_lock scoped claim 2 --owner sessionB
  [ "$status" -eq 1 ]
}

# --- conflicts ----------------------------------------------------------------

@test "scope: conflicts is clear when nothing is held" {
  setup_docs scoped scoped
  run pe_lock scoped conflicts 2 --scope "api-server"
  [ "$status" -eq 0 ]
  assert_contains "$output" "no scope conflicts"
}

@test "scope: a disjoint scope is clear (exit 0)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: an intersecting scope conflicts (exit 1) and names the holder" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server,docs"
  run pe_lock scoped conflicts 4 --scope "docs" --owner sessionB
  [ "$status" -eq 1 ]
  assert_contains "$output" "CONFLICT"
  assert_contains "$output" "sessionA"
  assert_contains "$output" "docs"
}

@test "scope: all collides with everything, in both directions" {
  setup_docs scoped scoped
  pe_lock scoped claim 5 --owner sessionA --scope "all"
  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 1 ]

  setup_docs scoped scoped
  pe_lock scoped claim 3 --owner sessionA --scope "web-app"
  run pe_lock scoped conflicts 5 --scope "all" --owner sessionB
  [ "$status" -eq 1 ]
}

@test "scope: a path prefix collides, a neighbouring name does not" {
  setup_docs scoped scoped
  pe_lock scoped claim 7 --owner sessionA --scope "packages"
  run pe_lock scoped conflicts 6 --scope "packages/cart-api" --owner sessionB
  [ "$status" -eq 1 ]

  # Segment-wise: `packages-legacy` is a different repository, not a child.
  run pe_lock scoped conflicts 6 --scope "packages-legacy" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: an expired lease is not a conflict" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server" --lease 0
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: our own live lock is not a conflict with ourselves" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped conflicts 4 --scope "api-server" --owner sessionA
  [ "$status" -eq 0 ]
}

@test "scope: a lock with no scope conflicts with everything (unknown is unsafe)" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA
  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 1 ]
  assert_contains "$output" "unstated"
}

@test "scope: conflicts sees locks held by OTHER plans" {
  # The whole point of the verb: a working tree does not know which plan asked
  # for it, so admission has to look across every plan's locks.
  setup_docs scoped scoped
  mkdir -p "$DOCS_ROOT/docs/plans" "$DOCS_ROOT/docs/handoffs/other"
  cp "$PE_DIR/tests/fixtures/plans/scoped.md" "$DOCS_ROOT/docs/plans/other.md"
  pe_lock other claim 2 --owner sessionA --scope "api-server"

  run pe_lock scoped conflicts 2 --scope "api-server" --owner sessionB
  [ "$status" -eq 1 ]
  assert_contains "$output" "other"

  run pe_lock scoped conflicts 3 --scope "web-app" --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: conflicts reads the plan when no scope is given" {
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  # Phase 4 is `api-server, docs` in the plan — collides without being told.
  run pe_lock scoped conflicts 4 --owner sessionB
  [ "$status" -eq 1 ]
  run pe_lock scoped conflicts 3 --owner sessionB
  [ "$status" -eq 0 ]
}

@test "scope: conflicts with no scope and no phase is a usage error" {
  setup_docs scoped scoped
  run pe_lock scoped conflicts --owner sessionB
  [ "$status" -eq 2 ]
}

@test "scope: conflicts never writes a lock" {
  setup_docs scoped scoped
  pe_lock scoped conflicts 2 --scope "api-server" --owner sessionB
  [ ! -f "$DOCS_ROOT/docs/handoffs/scoped/.locks/phase-02.lock" ]
}

@test "scope: claiming still refuses only the same phase, not an overlapping one" {
  # Deliberate: policy lives in the console, so an older script and an older
  # console keep working. `conflicts` is what answers the scope question.
  setup_docs scoped scoped
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  run pe_lock scoped claim 4 --owner sessionB --scope "api-server,docs"
  [ "$status" -eq 0 ]
}

# --- what the prompts tell a session to do ------------------------------------

@test "scope: the boot prompt carries the scope, the check and the invariant" {
  setup_docs scoped scoped
  run pg scoped --boot-prompt 6
  [ "$status" -eq 0 ]
  assert_contains "$output" "SCOPE"
  assert_contains "$output" "packages/cart-api"
  assert_contains "$output" "conflicts 6 --scope"
  # The claim command must NOT carry --owner: the autopilot exports PE_OWNER to
  # its sessions, and an explicit --owner in the prompt overrode it — the child
  # then held a lock the supervisor could not release, and a later retry parked
  # on "locked by a stranger". phase-lock.sh defaults to $PE_OWNER else user@host,
  # so the right command names no owner and the prose explains when a person may.
  assert_contains "$output" "claim 6 --scope"
  refute_contains "$output" "claim 6 --owner"
  assert_contains "$output" "PE_OWNER"
  assert_contains "$output" "disjoint ⇒ parallel"
  # The old unconditional rule is gone.
  refute_contains "$output" "run SERIALLY"
}

@test "scope: the next-phase banner separates disjoint siblings from shared ones" {
  setup_docs scoped scoped
  write_handoff scoped 1 root complete
  run pe_nextp scoped 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "Disjoint scopes"
  assert_contains "$output" "2∥3"
  assert_contains "$output" "Shared scope"
  assert_contains "$output" "6∩7"
}

@test "lock: releasing the last lock of a plan-less slug removes the empty husk" {
  # A slug with no plan, no handoffs and no INDEX exists only because a lock
  # was claimed under it. Releasing that lock must not leave a folder whose
  # entire content is an empty .locks/ — the viewer's store reads that as an
  # orphan that exists for no reason (one such husk was found live, left by a
  # stale-claim release).
  setup_docs scoped scoped
  pe_lock ghost claim 1 --owner sessionA --scope "api"
  [ -f "$DOCS_ROOT/docs/handoffs/ghost/.locks/phase-01.lock" ]
  pe_lock ghost release 1 --owner sessionA
  [ ! -d "$DOCS_ROOT/docs/handoffs/ghost" ]
}

@test "lock: releasing one lock of a slug with handoffs leaves the folder alone" {
  setup_docs scoped scoped
  write_handoff scoped 1 root complete
  pe_lock scoped claim 2 --owner sessionA --scope "api-server"
  pe_lock scoped release 2 --owner sessionA
  [ -d "$DOCS_ROOT/docs/handoffs/scoped" ]
}
