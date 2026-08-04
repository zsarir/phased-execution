#!/usr/bin/env bash
# End-of-phase output for Mode 3 (phase-finish): a stop banner, the live DAG board,
# and a copy-paste boot prompt for EVERY phase that is now unblocked — not just the
# next number. Delegates all graph logic to phase-graph.sh (the engine).
#
# Usage: next-phase-prompt.sh <slug> <completed-phase|none> [unused]
#   slug             : plan/handoff/memory slug
#   completed-phase  : the phase that just finished (its deps-unblocking is computed
#                      via the engine's --ready-after, so it counts as done even before
#                      the handoff is committed). Pass "none"/"last" to force closeout.
#
# Run from the repo root that owns docs/, or set DOCS_ROOT.
set -euo pipefail

slug="${1:?usage: next-phase-prompt.sh <slug> <completed-phase|none>}"
completed="${2:?completed-phase number (or 'none') required}"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$SKILL_DIR/scripts/phase-graph.sh"

_resolve_root() {
  [ -n "${DOCS_ROOT:-}" ] && { printf '%s' "$DOCS_ROOT"; return; }
  local r
  r="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$r" ] && { printf '%s' "$r"; return; }
  git rev-parse --show-toplevel 2>/dev/null || pwd
}
DOCS_ROOT="$(_resolve_root)"; export DOCS_ROOT
plan_file="$DOCS_ROOT/docs/plans/${slug}.md"
[ -f "$plan_file" ] || { printf 'ERROR: plan not found: %s\n' "$plan_file" >&2; exit 1; }

memory_key="$(grep -m1 '^memory:' "$plan_file" | sed 's/^memory:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
memory_key="${memory_key:-project_${slug}}"

# ---------------------------------------------------------------------------
# Final-phase closeout (explicit "none", or auto-detected all-done below).
# QA is opt-in (v3): the qa-full subagent brief prints only when the plan's
# qa-mode is "on" — waived plans get a note, qa-off plans nothing QA-related.
# §End-to-end verification is always run by the finishing session itself.
# ---------------------------------------------------------------------------
print_closeout() {
  local qa_mode
  qa_mode="$(bash "$ENGINE" "$slug" --qa-mode 2>/dev/null || echo off)"
  printf '\n🏁  All phases complete.\n'
  printf '   Set  status: complete  in  %s\n\n' "$plan_file"
  case "$qa_mode" in
    on*)
      printf 'Final full-plan QA (this plan runs QA: %s) — dispatch a FRESH qa-full QA subagent\n' "$qa_mode"
      printf '(clean context) with this brief before closing out:\n'
      printf '── QA SUBAGENT BRIEF ────────────────────────────────────────────\n'
      printf 'qa-full %s — independently verify the whole plan end-to-end. `git pull`; run the plan'\''s\n' "$slug"
      printf '§End-to-end verification for real; re-check every phase'\''s QA result; write the final report\n'
      printf 'under docs/handoffs/%s/reports/ and confirm test-status.md shows every phase pass|waived.\n' "$slug"
      printf 'Surface any regression before the plan is marked complete.\n'
      printf '── END BRIEF ────────────────────────────────────────────────────\n\n'
      ;;
    waived*)
      printf 'QA gate: %s — do NOT dispatch a qa-full subagent; run the verification yourself.\n\n' "$qa_mode"
      ;;
  esac
  printf 'Remaining steps:\n'
  printf '  1. Run §End-to-end verification in  docs/plans/%s.md  (always — QA on or off)\n' "$slug"
  printf '  2. Check memory %s for outstanding user gates (push / prod deploy).\n' "$memory_key"
  printf '  3. /clear — this project is done.\n\n'
}

if [ "$completed" = none ] || [ "$completed" = last ]; then
  print_closeout
  exit 0
fi

# ---------------------------------------------------------------------------
# Stop banner + live board.
# ---------------------------------------------------------------------------
printf '\n✅  Phase %s complete — committed, handoff written, memory updated.\n' "$completed"
bash "$ENGINE" "$slug"   # the human DAG board (done / ready / waiting summary)

# QA is opt-in (v3): when the plan's qa-mode is "on", the skill dispatched a fresh
# QA subagent before this script and it recorded pass — so this script just shows
# what is ready to start next. With qa-mode off/waived there was nothing to wait on.

# Ready set = everything startable now, treating the just-finished phase as done.
ready="$(bash "$ENGINE" "$slug" --ready-after "$completed")"

if [ -z "$ready" ]; then
  # Either the whole plan is done, or every remaining phase is still blocked.
  remaining="$(bash "$ENGINE" "$slug" --ready)"   # without the just-finished override
  if [ -z "$remaining" ]; then
    # nothing ready even without override — check if all done by re-reading the board's tail
    if bash "$ENGINE" "$slug" | grep -q 'All .* phases done'; then
      print_closeout
    else
      printf '\n⚠️  No phase is ready to start — every remaining phase is waiting on an\n'
      printf '   unfinished (or stuck) dependency. See WAITING above; resolve the blocker first.\n\n'
    fi
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# One boot prompt per ready phase.
# ---------------------------------------------------------------------------
n_ready="$(printf '%s\n' $ready | grep -c . || true)"

if [ "$n_ready" -gt 1 ]; then
  printf '\n▶  %s phases unblocked: %s — independent, and runnable in any order.\n' "$n_ready" "$(echo $ready | sed 's/ /, /g')"
  # Which of them share a working tree? Disjoint scopes may run as SEPARATE
  # sessions at the same time; anything overlapping is still one at a time.
  # shellcheck source=/dev/null
  . "$(dirname "$ENGINE")/scope.sh"
  pairs=""; overlap=""
  for a in $ready; do
    for b in $ready; do
      [ "$a" -lt "$b" ] || continue
      sa="$(bash "$ENGINE" "$slug" --repos "$a" 2>/dev/null || echo all)"
      sb="$(bash "$ENGINE" "$slug" --repos "$b" 2>/dev/null || echo all)"
      if scope_intersects "$sa" "$sb"; then overlap="$overlap ${a}∩${b}"; else pairs="$pairs ${a}∥${b}"; fi
    done
  done
  if [ -n "$pairs" ]; then
    printf '   Disjoint scopes (may run as PARALLEL sessions, one session per phase):%s\n' "$pairs"
  fi
  if [ -n "$overlap" ]; then
    printf '   Shared scope (SERIALIZE — never two live sessions on these):%s\n' "$overlap"
  fi
  printf '   Check before you start either way: `phase-lock.sh %s conflicts <N> --scope "<csv>" --git`.\n' "$slug"
  printf '   If the remaining session budget allows (your live context meter — references/sizing.md),\n'
  printf '   you MAY also continue into ONE of them in THIS session (not a 🔒GATED one — those always\n'
  printf '   start fresh after their gates are confirmed). Commit before switching sessions; never\n'
  printf '   `git stash` to hand off.\n'
else
  # Single next phase: continue into it in THIS session whenever it fits the remaining
  # budget (only gates, a model switch, or a spent budget force a fresh session).
  sz="$(bash "$ENGINE" "$slug" --size "$ready" 2>/dev/null || echo M)"
  rdeps=" $(bash "$ENGINE" "$slug" --deps "$ready" 2>/dev/null || true) "
  gated_next="$(bash "$ENGINE" "$slug" --gated "$ready" 2>/dev/null || echo no)"
  seq=no; case "$rdeps" in *" $completed "*) seq=yes ;; esac
  if [ "$gated_next" = yes ]; then
    printf '\n▶  Next ready phase: %s  (size %s) — 🔒 GATED.\n' "$ready" "$sz"
    printf '   ⚠️  STOP here — confirm its gates are cleared, then start it in a FRESH session\n'
    printf '   using the prompt below (gated phases are never batched past).\n'
  elif [ "$seq" = yes ]; then
    printf '\n▶  Next ready phase: %s  (size %s, sequential on Phase %s) — BATCH-FRIENDLY.\n' "$ready" "$sz" "$completed"
    printf '   If it fits the remaining session budget (references/sizing.md), just continue into it in\n'
    printf '   THIS session — saves a bootstrap and keeps the cache warm. Otherwise /clear and paste the\n'
    printf '   prompt below into a fresh session.\n'
  else
    printf '\n▶  Next ready phase: %s  (size %s, independent of the phase just finished).\n' "$ready" "$sz"
    printf '   It may still share THIS session if the remaining budget allows (references/sizing.md);\n'
    printf '   otherwise /clear and start it fresh with the prompt below.\n'
  fi
fi

for p in $ready; do
  gated="$(bash "$ENGINE" "$slug" --gated "$p")"
  gmark=""; [ "$gated" = yes ] && gmark=" — 🔒 GATED (confirm gates first)"
  printf '\n── START COPY — Phase %s%s ─────────────────────────────────\n' "$p" "$gmark"
  bash "$ENGINE" "$slug" --boot-prompt "$p"
  printf '── END COPY ────────────────────────────────────────────────────\n'
done
echo
