#!/usr/bin/env bash
# Scaffold a phase handoff + create/update the per-plan INDEX.md.
# Auto-fills graph-derived frontmatter (depends_on / blocks) and the
# "▶ Start next phase(s)" section (one boot prompt per phase THIS phase unblocks)
# by delegating to scripts/phase-graph.sh.
#
# Usage: new-handoff.sh <slug> <phase-number> <title> [status]
#   status : complete | in-progress | blocked | pending  (default: complete)
#   --qa   : force QA ON for this finish (the user asked for QA now) even if the
#            plan's qa-mode is off — creates test-status.md and turns on gating.
# Run from repo root that owns docs/, or set DOCS_ROOT.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$SKILL_DIR/scripts/phase-graph.sh"

# F8: optional --force (anywhere in args) re-scaffolds an existing handoff (repair).
force=0; force_qa=0; _args=()
for _a in "$@"; do
  case "$_a" in
    --force) force=1 ;;
    --qa)    force_qa=1 ;;
    *)       _args+=("$_a") ;;
  esac
done
set -- ${_args[@]+"${_args[@]}"}

slug="${1:?usage: new-handoff.sh <slug> <phase-number> <title> [status] [--force] [--qa]}"
phase="${2:?phase number required}"
title="${3:?title required}"
status="${4:-complete}"

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
DOCS_ROOT="$(_resolve_root)"; export DOCS_ROOT
if [ ! -d "$DOCS_ROOT/docs" ]; then
  printf 'ERROR: docs/ not found under DOCS_ROOT=%s\n' "$DOCS_ROOT" >&2
  printf '  → run from the repo root, or: DOCS_ROOT=/path/to/repo %s ...\n' "$(basename "$0")" >&2
  exit 1
fi

dir="$DOCS_ROOT/docs/handoffs/${slug}"
mkdir -p "$dir"
padded="$(printf '%02d' "$phase")"
date_str="$(date +%F)"
this_handoff="phase-${padded}-${title}.md"

# Read memory key from plan frontmatter (default: project_<slug>).
plan_file="$DOCS_ROOT/docs/plans/${slug}.md"
memory_key="$(grep -m1 '^memory:' "$plan_file" 2>/dev/null \
  | sed 's/^memory:[[:space:]]*//' | sed 's/[[:space:]]*#.*$//' || true)"
memory_key="${memory_key:-project_${slug}}"

# Determine next phase number (or "none" if this is the final phase).
next_phase="$((phase + 1))"
if [ -f "$plan_file" ]; then
  total_phases="$(grep -m1 '^phases:' "$plan_file" \
    | sed 's/^phases:[[:space:]]*//' | sed 's/[[:space:]]*#.*$//' || true)"
  if [ -n "$total_phases" ] && [ "$total_phases" != "TODO" ] && [ "$phase" = "$total_phases" ]; then
    next_phase="none"
  fi
fi

# ---------------------------------------------------------------------------
# Graph-derived frontmatter. Degrade gracefully if the plan has no parseable
# "## Phase graph" table yet (GRAPH_OK=0 → legacy linear behaviour).
# ---------------------------------------------------------------------------
# Scaffolding a handoff into a closed plan is almost always a mistake — someone is
# working from a stale boot prompt on a plan that has been walked away from. Say so,
# and name the way back, rather than silently producing a handoff nobody will read.
if closed="$(bash "$ENGINE" "$slug" --closed 2>/dev/null)" && [ "$force" = 0 ]; then
  echo "refusing: $slug is closed (${closed#closed })" >&2
  echo "  → reopen it first:  scripts/close-plan.sh $slug --reopen" >&2
  echo "  → or pass --force to scaffold into the closed plan anyway" >&2
  exit 2
fi

GRAPH_OK=0
if bash "$ENGINE" "$slug" --ready >/dev/null 2>&1; then GRAPH_OK=1; fi

deps_csv=""; blocks_csv=""
if [ "$GRAPH_OK" = 1 ]; then
  deps_csv="$(bash "$ENGINE" "$slug" --deps "$phase" 2>/dev/null | sed 's/^ *//; s/ *$//; s/  */, /g')"
  blocks_csv="$(bash "$ENGINE" "$slug" --dependents "$phase" 2>/dev/null | sed 's/^ *//; s/ *$//; s/  */, /g')"
fi

# Create INDEX.md if missing.
index="$dir/INDEX.md"
if [ ! -e "$index" ]; then
  sed -e "s|{{SLUG}}|${slug}|g" \
      -e "s|{{MEMORY_KEY}}|${memory_key}|g" \
    "$SKILL_DIR/templates/INDEX.md" > "$index"
  echo "created $index"
fi

# Track QA status — OPT-IN since v3. The engine's --qa-mode says whether this plan
# runs QA (on: dispatch a subagent at finish · waived: record rows, never dispatch ·
# off: no QA artifact at all — the default). Only a non-off mode creates/updates
# test-status.md, whose existence is what turns on dependent gating.
qa_mode="$(bash "$ENGINE" "$slug" --qa-mode 2>/dev/null || echo off)"
if [ "$force_qa" = 1 ]; then
  case "$qa_mode" in off) qa_mode="on (--qa flag)" ;; esac
fi
qa_status="$dir/test-status.md"
if [ "$qa_mode" != off ]; then
  created_qa=0
  if [ ! -f "$qa_status" ]; then
    {
      printf '# QA / test status — %s\n\n' "$slug"
      printf 'Per-phase QA results recorded by phased-execution'\''s QA step. The engine reads the\n'
      printf '"Result" column to gate dependents: a phase is *verified* only when its handoff is\n'
      printf 'complete AND its Result is `pass` or `waived`. Values: pass | fail | pending | waived.\n\n'
      printf '## QA status\n\n| Phase | Result | Report |\n|------:|--------|--------|\n'
    } > "$qa_status"
    created_qa=1
    echo "created $qa_status"
  fi
  # Mid-plan activation backfill: if the file is NEW but earlier phases already have
  # complete handoffs, record them as waived (pre-activation) — otherwise gating turns
  # on plan-wide and every previously-done phase reads qa_result=none, retroactively
  # flipping its dependents ready→waiting.
  if [ "$created_qa" = 1 ]; then
    for _hf in "$dir"/phase-*.md; do
      [ -e "$_hf" ] || continue
      _hn="$(basename "$_hf" | sed -E 's/^phase-0*([0-9]+)-.*/\1/')"
      case "$_hn" in ''|*[!0-9]*) continue ;; esac
      [ "$_hn" = "$phase" ] && continue
      _hst="$(grep -m1 '^status:' "$_hf" | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
      [ "$_hst" = complete ] || continue
      if ! grep -qE "^\|[[:space:]]*${_hn}[[:space:]]*\|" "$qa_status"; then
        printf '| %s | waived | - |\n' "$_hn" >> "$qa_status"
        echo "backfilled phase $_hn as waived (completed before QA activation)"
      fi
    done
  fi
  if ! grep -qE "^\|[[:space:]]*${phase}[[:space:]]*\|" "$qa_status"; then
    case "$qa_mode" in
      waived*) qa_res="waived" ;;
      *)       qa_res="pending"; [ "$status" = complete ] || qa_res="-" ;;
    esac
    printf '| %s | %s | - |\n' "$phase" "$qa_res" >> "$qa_status"
    echo "updated $qa_status"
  fi
fi

# Scaffold the handoff from template.
dest="$dir/${this_handoff}"
if [ -e "$dest" ] && [ "$force" = 0 ]; then
  echo "refusing to overwrite existing handoff: $dest (use --force to repair)" >&2
  exit 1
fi
[ -e "$dest" ] && echo "overwriting existing handoff (--force): $dest"
sed -e "s|{{SLUG}}|${slug}|g" \
    -e "s|{{DATE}}|${date_str}|g" \
    -e "s|{{PHASE}}|${phase}|g" \
    -e "s|{{TITLE}}|${title}|g" \
    -e "s|{{STATUS}}|${status}|g" \
    -e "s|{{NEXT_PHASE}}|${next_phase}|g" \
    -e "s|{{THIS_HANDOFF}}|${this_handoff}|g" \
    -e "s|{{DEPENDS_ON}}|${deps_csv}|g" \
    -e "s|{{BLOCKS}}|${blocks_csv}|g" \
    -e "s|{{MEMORY_KEY}}|${memory_key}|g" \
  "$SKILL_DIR/templates/handoff.md" > "$dest"

# ---------------------------------------------------------------------------
# Build the "▶ Start next phase(s)" body and splice it into the {{NEXT_PROMPTS}}
# placeholder. One self-contained boot prompt per phase this phase unblocks.
# ---------------------------------------------------------------------------
prompts_tmp="$(mktemp)"
{
  if [ "$next_phase" = none ]; then
    printf '## 🏁 Final phase — closeout\n\n'
    case "$qa_mode" in
      on*)     printf -- '- Dispatch the fresh **qa-full** QA subagent (this plan runs QA) — brief via `scripts/next-phase-prompt.sh %s none`.\n' "$slug" ;;
      waived*) printf -- '- QA gate waived for this plan — no qa-full subagent; verify yourself.\n' ;;
    esac
    printf -- '- Set `status: complete` in `docs/plans/%s.md`.\n' "$slug"
    printf -- '- Run §End-to-end verification in the plan (always — QA on or off).\n'
    printf -- '- Confirm every phase is `done` (`scripts/phase-graph.sh %s` shows 🏁), not just this one.\n' "$slug"
    printf -- '- Check memory `%s` for outstanding user gates (push / prod deploy).\n' "$memory_key"
    printf -- '- `/clear` when done.\n'
  elif [ "$GRAPH_OK" = 1 ]; then
    ready="$(bash "$ENGINE" "$slug" --ready-after "$phase" 2>/dev/null || true)"
    if [ -z "$ready" ]; then
      printf '_Completing Phase %s does not unblock any phase yet — downstream phases still\n' "$phase"
      printf 'wait on other dependencies. Run `scripts/phase-graph.sh %s` for the WAITING list._\n' "$slug"
    else
      nready=$(printf '%s\n' $ready | grep -c . || true)
      if [ "$nready" -gt 1 ]; then
        printf '> Phases **%s** are all unblocked — run them in any order. Ones with DISJOINT\n' "$(echo $ready | sed 's/ /, /g')"
        printf '> scopes may run as concurrent sessions; ones sharing a repo run one at a time. Each boot\n'
        printf '> prompt below states its scope and the `phase-lock.sh … conflicts` check to run first.\n'
        printf '> If the remaining budget allows, the finishing session MAY instead continue straight into\n'
        printf '> ONE of them (not a 🔒GATED one). Commit before switching sessions; never `git stash`.\n\n'
      else
        # Single next phase — batch-friendly whenever the remaining budget fits (gated
        # phases excepted: they always start fresh after their gates are confirmed).
        sz="$(bash "$ENGINE" "$slug" --size "$ready" 2>/dev/null || echo M)"
        rdeps=" $(bash "$ENGINE" "$slug" --deps "$ready" 2>/dev/null || true) "
        gated_next="$(bash "$ENGINE" "$slug" --gated "$ready" 2>/dev/null || echo no)"
        if [ "$gated_next" != yes ]; then
          case "$rdeps" in
            *" $phase "*)
              printf '> _Phase %s (size %s) is sequential on this one — you MAY continue into it in the SAME\n> session if it fits the remaining budget (`references/sizing.md`); otherwise use the prompt below in a fresh session._\n\n' "$ready" "$sz" ;;
            *)
              printf '> _Phase %s (size %s) is independent of this one — it may still share the SAME session\n> if the remaining budget allows (`references/sizing.md`); otherwise use the prompt below in a fresh session._\n\n' "$ready" "$sz" ;;
          esac
        fi
      fi
      for p in $ready; do
        gated="$(bash "$ENGINE" "$slug" --gated "$p" 2>/dev/null || echo no)"
        gmark=""; [ "$gated" = yes ] && gmark=' — 🔒 GATED'
        printf '### Phase %s%s\n\n' "$p" "$gmark"
        printf '```\n'
        bash "$ENGINE" "$slug" --boot-prompt "$p"
        printf '```\n\n'
      done
    fi
  else
    # Legacy fallback: no parseable graph → single linear next-phase prompt.
    printf '```\n'
    printf '/phased-execution\n\n'
    printf 'Continue the "%s" plan — start Phase %s in this fresh session.\n' "$slug" "$next_phase"
    printf 'Bootstrap from disk only:\n'
    printf -- '- docs/handoffs/%s/%s\n' "$slug" "$this_handoff"
    printf -- '- docs/plans/%s.md §Phase %s + §Session budget (model, budget, branch)\n' "$slug" "$next_phase"
    printf -- '- memory %s\n' "$memory_key"
    printf 'Then build the p%s.task* list and implement Phase %s to its exit criteria.\n' "$next_phase" "$next_phase"
    printf 'Stop + hand off when done.\n'
    printf '```\n'
  fi
} > "$prompts_tmp"

awk -v sf="$prompts_tmp" '
  $0 == "{{NEXT_PROMPTS}}" { while ((getline l < sf) > 0) print l; next }
  { print }
' "$dest" > "$dest.tmp" && mv "$dest.tmp" "$dest"
rm -f "$prompts_tmp"

# Append INDEX row if not already listed.
if ! grep -qF "${this_handoff}" "$index"; then
  printf '| %s | %s | %s | [%s](%s) |\n' \
    "$padded" "$title" "$status" "${this_handoff}" "${this_handoff}" >> "$index"
fi

echo "created $dest"
echo "updated $index"
