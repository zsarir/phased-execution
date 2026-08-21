#!/usr/bin/env bats
# phase-lock.sh — cooperative phase claims with a lease (the concurrency guard).
# Contract: phase-lock.sh <slug> <claim|release|status|list> <N> [--owner X] [--lease SECS]
# Lock files live at docs/handoffs/<slug>/.locks/phase-NN.lock
# RED until scripts/phase-lock.sh exists.
load ../helpers/test_helper

setup() {
  # The `session=` line is written only when an id is known; this suite may
  # itself run inside a Claude session that exports one.
  unset PE_SESSION_ID CLAUDE_CODE_SESSION_ID
}

@test "lock: claim creates the lock file under .locks/" {
  setup_docs linear linear
  run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
  [ -f "$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock" ]
}

@test "lock: a second owner is refused and told who holds it" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -ne 0 ]
  assert_contains "$output" "sessionA"
}

@test "lock: same owner re-claim is idempotent (exit 0)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionA
  [ "$status" -eq 0 ]
}

# The autopilot's lease keepalive is exactly a same-owner re-claim on a timer:
# a live 47-minute phase must never lose its 30-minute lease mid-work (a lapsed
# lease is silently taken over by anyone). This pins the two facts the
# keepalive stands on: the lease moves forward, and the scope line survives.
@test "lock: same-owner re-claim REFRESHES the lease and keeps the scope line" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA --scope "repoA" --lease 60
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  first="$(grep '^lease_until=' "$f")"
  run pe_lock linear claim 1 --owner sessionA --scope "repoA" --lease 3600
  [ "$status" -eq 0 ]
  assert_contains "$output" "refreshed"
  second="$(grep '^lease_until=' "$f")"
  [ "$first" != "$second" ]
  # scope_normalize lowercases; the file carries the normalized csv.
  grep -q '^scope=.*repoa' "$f"
}

@test "lock: release frees the lock for another owner" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  pe_lock linear release 1 --owner sessionA
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -eq 0 ]
}

@test "lock: an expired lease can be taken over" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA --lease 0
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -eq 0 ]
  assert_contains "$output" "takeover"
}

@test "lock: status names the current holder" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  run pe_lock linear status 1
  assert_contains "$output" "sessionA"
}

@test "lock: status of an unclaimed phase reports free" {
  setup_docs linear linear
  run pe_lock linear status 1
  [ "$status" -eq 0 ]
  assert_contains "$output" "free"
}

# ---- session= : the presence channel between a lock and the console ----------

@test "lock: --session writes a session= line and status/list print it" {
  setup_docs linear linear
  run pe_lock linear claim 1 --owner sessionA --session s1
  [ "$status" -eq 0 ]
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  grep -q '^session=s1$' "$f"
  run pe_lock linear status 1
  assert_contains "$output" "[session: s1]"
  run pe_lock linear list
  assert_contains "$output" "[session: s1]"
}

@test "lock: no session known ⇒ no session= line (older readers see the lock they always saw)" {
  setup_docs linear linear
  pe_lock linear claim 1 --owner sessionA
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  ! grep -q '^session=' "$f"
  run pe_lock linear status 1
  refute_contains "$output" "session:"
}

@test "lock: the session defaults to PE_SESSION_ID, then CLAUDE_CODE_SESSION_ID; --session beats both" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  PE_SESSION_ID="env-1" pe_lock linear claim 1 --owner sessionA
  grep -q '^session=env-1$' "$f"
  pe_lock linear release 1 --owner sessionA
  CLAUDE_CODE_SESSION_ID="cc-2" pe_lock linear claim 1 --owner sessionA
  grep -q '^session=cc-2$' "$f"
  pe_lock linear release 1 --owner sessionA
  PE_SESSION_ID="env-1" CLAUDE_CODE_SESSION_ID="cc-2" pe_lock linear claim 1 --owner sessionA
  grep -q '^session=env-1$' "$f"
  pe_lock linear release 1 --owner sessionA
  PE_SESSION_ID="env-1" pe_lock linear claim 1 --owner sessionA --session flag-3
  grep -q '^session=flag-3$' "$f"
  # Only id characters survive — one line in a key=value file.
  pe_lock linear release 1 --owner sessionA
  pe_lock linear claim 1 --owner sessionA --session 'a b=c'
  grep -q '^session=abc$' "$f"
}

@test "lock: a same-owner refresh that names no session KEEPS the session= line (the runner's keepalive must not strip it)" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  pe_lock linear claim 1 --owner sessionA --scope repoA --session s1 --lease 60
  run pe_lock linear claim 1 --owner sessionA --scope repoA --lease 3600
  [ "$status" -eq 0 ]
  assert_contains "$output" "refreshed"
  grep -q '^session=s1$' "$f"
  # A refresh that names a NEW session replaces it.
  pe_lock linear claim 1 --owner sessionA --scope repoA --session s2
  grep -q '^session=s2$' "$f"
  ! grep -q '^session=s1$' "$f"
}

@test "lock: a takeover writes the taker's session, never the previous holder's" {
  setup_docs linear linear
  f="$DOCS_ROOT/docs/handoffs/linear/.locks/phase-01.lock"
  pe_lock linear claim 1 --owner sessionA --session s1 --lease 0
  run pe_lock linear claim 1 --owner sessionB
  [ "$status" -eq 0 ]
  ! grep -q '^session=' "$f"
}
