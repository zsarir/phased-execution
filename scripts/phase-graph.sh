#!/usr/bin/env bash
# Phase-graph engine for phased-execution.
#
# Treats a plan as a DAG, not a linear chain. Reads the dependency structure from
# the plan's "## Phase graph" markdown table (Depends-on column) and the LIVE
# per-phase status from each handoff's frontmatter, then computes for every phase:
#   done | in-progress | ready | waiting
# "ready" = not started AND every dependency is done. This is what lets phases run
# concurrently and out of order: readiness is computed from the done-SET, never from
# a linear cursor. A plan is finished only when EVERY phase is done — not when the
# highest-numbered phase is reached.
#
# Usage:
#   phase-graph.sh <slug>                 # human status board (default; shows SUGGESTED BATCHES)
#   phase-graph.sh <slug> --ready         # space-separated ready phase numbers
#   phase-graph.sh <slug> --ready-after N # ready set assuming phase N just completed
#   phase-graph.sh <slug> --dependents N  # phases that list N as a dependency (static)
#   phase-graph.sh <slug> --deps N        # N's own dependencies (space-separated)
#   phase-graph.sh <slug> --gated N       # "yes"/"no"
#   phase-graph.sh <slug> --size N        # rough working-set size of phase N (S|M|L; default M)
#   phase-graph.sh <slug> --repos N       # phase N's SCOPE as normalized csv (Repos column; "" → all)
#   phase-graph.sh <slug> --boot-prompt N # full copy-paste boot prompt for phase N
#   phase-graph.sh <slug> --session-plan [model|budget]
#                                         # propose which REMAINING phases to batch into one session,
#                                         # sized to a model's budget (haiku|sonnet|opus|fable) or a
#                                         # raw token number. Groups cut only at unmet deps, GATED
#                                         # phases, QA boundaries, and the budget. See references/sizing.md.
#
# Run from the repo root that owns docs/, or set DOCS_ROOT.
set -euo pipefail

slug="${1:?usage: phase-graph.sh <slug> [--lint|--qa-mode|--qa-result N|--qa-prompt N|--gate-status N|--memory-block|--plan-status|--closed|--ready|--ready-after N|--dependents N|--deps N|--gated N|--size N|--repos N|--boot-prompt N|--session-plan [model|budget]]}"
mode="${2:-board}"
arg="${3:-}"

# Script dir — portable across accounts/clones (F13): never hardcode ~/.claude.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# One bash reading of the Repos column, shared with phase-lock.sh.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/scope.sh"

# F5: single source of truth for sizing + budgets. Canonical values live in
# scripts/sizing.env (also documented in references/sizing.md); these defaults are
# a fallback so the script still runs if the file is ever missing.
SIZE_S=15000; SIZE_M=40000; SIZE_L=90000
BUDGET_HAIKU=90000; BUDGET_BIG=1000000; BUDGET_DEFAULT=120000
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/sizing.env" ] && . "$SCRIPT_DIR/sizing.env"

# ---------------------------------------------------------------------------
# Resolve DOCS_ROOT (superproject-aware: handles submodule cwd).
# ---------------------------------------------------------------------------
_resolve_root() {
  [ -n "${DOCS_ROOT:-}" ] && { printf '%s' "$DOCS_ROOT"; return; }
  local r
  r="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$r" ] && { printf '%s' "$r"; return; }
  git rev-parse --show-toplevel 2>/dev/null || pwd
}
DOCS_ROOT="$(_resolve_root)"
plan_file="$DOCS_ROOT/docs/plans/${slug}.md"
handoff_dir="$DOCS_ROOT/docs/handoffs/${slug}"

if [ ! -f "$plan_file" ]; then
  printf 'ERROR: plan not found: %s\n' "$plan_file" >&2
  printf '  → run from the repo root, or set DOCS_ROOT: DOCS_ROOT=/path/to/repo %s ...\n' "$(basename "$0")" >&2
  if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
    printf '  ⚠️  not inside a git repo (root fell back to %s) — set DOCS_ROOT explicitly.\n' "$DOCS_ROOT" >&2
  fi
  exit 1
fi

memory_key="$(grep -m1 '^memory:' "$plan_file" 2>/dev/null \
  | sed 's/^memory:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
memory_key="${memory_key:-project_${slug}}"

# ---------------------------------------------------------------------------
# Closure. Progress is computed from the handoffs; "does anyone still care?" cannot
# be, so it is stored in the plan's own `status:`. A terminal status means CLOSED:
# the board still renders, but the plan stops reporting work, warnings and prompts.
# Values in the wild carry a trailing "# active | complete | …" legend — strip it.
# ---------------------------------------------------------------------------
_fm_field() {  # _fm_field <name> — first frontmatter-style value, legend stripped
  grep -m1 "^$1:" "$plan_file" 2>/dev/null \
    | sed "s/^$1:[[:space:]]*//; s/[[:space:]]*#.*\$//; s/[[:space:]]*\$//" || true
}
PLAN_STATUS="$(_fm_field status)"
PLAN_STATUS="$(printf '%s' "${PLAN_STATUS:-active}" | tr '[:upper:]' '[:lower:]')"
PLAN_STATUS="${PLAN_STATUS%% *}"
PLAN_CLOSED_ON="$(_fm_field closed)"
PLAN_CLOSED_REASON="$(_fm_field closed_reason)"
case "$PLAN_STATUS" in
  complete|abandoned|superseded) PLAN_CLOSED=1 ;;
  *)                             PLAN_CLOSED=0 ;;
esac

plan_is_closed() { [ "$PLAN_CLOSED" = 1 ]; }

# The one-line banner every closed-plan surface prints.
closed_banner() {
  local extra=""
  [ -n "$PLAN_CLOSED_REASON" ] && extra=" — $PLAN_CLOSED_REASON"
  [ -n "$PLAN_CLOSED_ON" ] && extra="$extra (closed $PLAN_CLOSED_ON)"
  printf '🔒 CLOSED [%s]%s\n' "$PLAN_STATUS" "$extra"
  printf '   This plan no longer reports work or warnings. Reopen it with:\n'
  printf '   scripts/close-plan.sh %s --reopen\n' "$slug"
}

# ---------------------------------------------------------------------------
# Parse the Phase-graph table → "phase<TAB>dep dep …<TAB>title".
# En/em dashes are normalised to ASCII '-' up front so range tokens (1-7) and the
# "none" marker (a lone dash, no digits) are both handled by one ASCII parser.
# Ranges like 1-7 expand to 1 2 3 4 5 6 7; "(+8-10)" → 8 9 10.
# ---------------------------------------------------------------------------
parse_table() {
  # Scope strictly to the "## Phase graph" table block (the consecutive | rows
  # after that heading) so OTHER pipe tables in the plan (repo legends, risk
  # tables, …) can never be misread as phase rows.
  sed 's/–/-/g; s/—/-/g' "$plan_file" | awk -F'|' '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    tolower($0) ~ /^##[[:space:]]+phase graph/ { inpg=1; seen=0; next }
    inpg && seen && $0 !~ /^[[:space:]]*\|/ { inpg=0 }
    inpg && /^[[:space:]]*\|/ {
      seen=1
      ph = trim($2)
      gsub(/[*`]/, "", ph); ph = trim(ph)    # strip markdown bold/code (| **6** |)
      if (ph !~ /^[0-9]+$/) next             # skip header / separator / prose rows
      title = trim($3); gsub(/[*`]/, "", title); title = trim(title)
      raw   = trim($4)                        # Depends-on column
      gsub(/[^0-9-]+/, " ", raw)             # keep only digits + hyphens (range marks)
      out = ""
      n = split(raw, toks, /[ ]+/)
      for (i = 1; i <= n; i++) {
        t = toks[i]
        if (t ~ /^[0-9]+-[0-9]+$/) {         # range A-B → A..B
          split(t, r, "-")
          for (j = r[1]; j <= r[2]; j++) out = out " " j
        } else if (t ~ /^[0-9]+$/) {
          out = out " " t
        }
      }
      sub(/^ /, "", out)
      repos = trim($6)                        # Repos column = the SCOPE of a phase
      gsub(/[*`]/, "", repos); repos = trim(repos)
      # US (\037) field separator, not tab: tab is IFS-whitespace, so an empty
      # deps field between two tabs would coalesce and shift the title out.
      print ph "\037" out "\037" title "\037" repos
    }'
}

# Gated detection: reuse the heading convention (### Phase N … *(GATED)*).
# Case-SENSITIVE on purpose. The marker is uppercase; matching case-insensitively also fires on
# lowercase prose in the row ("born-gated" terraform, "assignment-gated" review, "user-gated"),
# which freezes a ready phase behind a gate the plan never declared.
is_gated() {  # is_gated <phase>  → echoes yes|no
  if grep -q "^### Phase ${1}\b.*GATED" "$plan_file" 2>/dev/null \
     || grep -qE "^\|[[:space:]]*${1}[[:space:]]*\|.*GATED" "$plan_file" 2>/dev/null; then
    echo yes
  else
    echo no
  fi
}

# Extract a gated phase's gate conditions from "- **Gates (must clear first):** …".
gate_conditions() {  # gate_conditions <phase>
  grep -A6 "^### Phase ${1}\b" "$plan_file" 2>/dev/null \
    | grep -i 'Gates (must clear' \
    | sed 's/.*Gates[^:]*:[[:space:]]*//; s/^[*[:space:]]*//; s/[[:space:]]*$//' \
    | head -1 || true
}

# Lines of the "### Phase N" block (until the next ### Phase / ## heading) — read
# per-phase directives without spilling into a neighbour's block (F12).
phase_block() {  # phase_block <phase>
  awk -v want="$1" '
    /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
      h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
      cur=(h==want)?1:0
    }
    /^##[[:space:]]/ && cur { cur=0 }   # a new ## section ends the block
    cur { print }
  ' "$plan_file"
}

# F12: the machine-checkable "- **Gate-check:** <type> <value>" directive, if any.
gate_check_directive() {  # gate_check_directive <phase>
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*].*gate-check' \
    | sed -E 's/.*[Gg]ate-check[^:]*:[[:space:]]*//; s/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
    | head -1 || true
}

# The gate-check vocabulary, in one place so --gate-status and --lint cannot
# drift apart. A directive whose type is not on this list is treated as manual
# (fail-safe), and --lint now reports it rather than letting it pass silently:
# a typo used to demote an automated gate to a human one with no warning.
GATE_TYPES="phase phases plan cmd date deadline by manual"

_gate_type_known() {  # _gate_type_known <type>
  case " $GATE_TYPES " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# A real YYYY-MM-DD, not merely something shaped like one. Shape alone let
# "2020-13-99" through, and since the comparison is numeric it then read as a
# date already past — a gate that opened itself. Range-checked rather than
# handed to `date`, whose flags differ between BSD and GNU.
_valid_date() {  # _valid_date <string>
  case "$1" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) return 1 ;; esac
  local m d
  # 10# forces base 10: "08" and "09" are invalid octal and would error out.
  m=$((10#${1:5:2})); d=$((10#${1:8:2}))
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] && [ "$d" -ge 1 ] && [ "$d" -le 31 ]
}

# Portable bounded execution — macOS ships neither GNU `timeout` nor `gtimeout`,
# but it does ship perl. A gate command that hangs must not wedge the engine.
_run_bounded() {  # _run_bounded <seconds> <command-string>
  if command -v timeout >/dev/null 2>&1; then
    timeout "$1" bash -c "$2"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$1" bash -c "$2"
  else
    perl -e 'alarm shift; exec @ARGV' "$1" bash -c "$2"
  fi
}

# Commands no gate has any business running. A gate answers "is the world in the
# required state" — it never changes the world. Defence in depth behind the
# opt-in below, not the primary control.
#
# Kept in step with MUTATION_DENY in viewer/server/runner/verify.ts — the two
# state the same policy for the two places a plan's shell text gets executed, and
# `test/verify-extract.test.ts` fails when they drift. They had already drifted:
# this copy was missing sudo, git commit/rebase/merge, docker system prune and
# the redirect clause.
GATE_CMD_DENY='(^|[;&|[:space:]])(rm|mv|dd|mkfs|shutdown|reboot|kill|pkill|chown|chmod|sudo)([[:space:]]|$)|terraform[[:space:]]+(apply|destroy)|git[[:space:]]+(push|reset|clean|checkout|commit|rebase|merge)|docker[[:space:]]+(rm|rmi|kill|stop|system[[:space:]]+prune)|task[[:space:]]+[a-z:]*(deploy|ship|update|apply|destroy)|[[:space:]](delete|put|create|set|modify|terminate|reboot)-|>[[:space:]]*/|>>[[:space:]]*/'

# Executing a command written in a markdown file is remote code execution by
# document: clone a repo, run the board, run their shell. So `cmd` gates are OFF
# unless the caller opts in with PHASE_EXEC_GATES=1 — which the console's runner
# does deliberately and a passer-by does not. When off the gate still reports
# itself, showing the exact command, so a human and the automation never
# disagree about what the gate says.
_gate_exec_enabled() { [ "${PHASE_EXEC_GATES:-0}" = "1" ]; }

# Evaluate a `cmd` gate. Echoes the verdict; returns 0 = clear, 1 = not clear.
_gate_cmd() {  # _gate_cmd <command-string>
  local out rc
  if printf '%s' "$1" | grep -qE "$GATE_CMD_DENY"; then
    printf 'manual: REFUSED — a gate must not mutate anything: %s\n' "$1"
    return 1
  fi
  if ! _gate_exec_enabled; then
    printf 'manual: cmd gate not executed (set PHASE_EXEC_GATES=1 to evaluate): %s\n' "$1"
    return 1
  fi
  out="$(_run_bounded "${PHASE_GATE_TIMEOUT:-15}" "$1" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'clear (cmd ok): %s\n' "$1"
    return 0
  fi
  # 124 is what both timeout implementations use; perl's alarm kills with SIGALRM (142).
  case "$rc" in
    124|142) printf 'blocked: cmd timed out after %ss: %s\n' "${PHASE_GATE_TIMEOUT:-15}" "$1" ;;
    *)       printf 'blocked: cmd exit %s: %s%s\n' "$rc" "$1" \
               "$( [ -n "$out" ] && printf ' — %s' "$(printf '%s' "$out" | head -1)" )" ;;
  esac
  return 1
}

# Are these phases of ANOTHER plan done? Delegates to this same script rather
# than re-reading a second plan's handoffs here — one implementation of "done".
_gate_plan() {  # _gate_plan <slug:phases>
  local other list done_line missing q
  other="${1%%:*}"; list="${1#*:}"
  if [ "$other" = "$1" ] || [ -z "$list" ]; then
    printf 'manual: malformed plan gate (expected <slug>:<phases>): %s\n' "$1"
    return 1
  fi
  if [ ! -f "$DOCS_ROOT/docs/plans/${other}.md" ]; then
    printf 'blocked: plan gate references a plan that does not exist: %s\n' "$other"
    return 1
  fi
  done_line="$(DOCS_ROOT="$DOCS_ROOT" "$0" "$other" --memory-block 2>/dev/null \
    | grep '^done:' | sed 's/^done:[[:space:]]*//' || true)"
  # Comma-delimited on both sides so "1" cannot match inside "11".
  local done_set
  done_set=",$(printf '%s' "$done_line" | tr -d ' '),"
  missing=""
  for q in $(printf '%s' "$list" | tr ',' ' '); do
    case "$q" in ''|*[!0-9]*) continue ;; esac
    case "$done_set" in
      *",$q,"*) ;;
      *) missing="$missing $q" ;;
    esac
  done
  if [ -z "$missing" ]; then
    printf 'clear (%s phases %s done)\n' "$other" "$list"
    return 0
  fi
  printf 'blocked: %s phase(s)%s not done\n' "$other" "$missing"
  return 1
}

# Rough working-set size of a phase: S | M | L (default M). Read from a
# "- **Size:** X" bullet in the ### Phase N block — mirrors the Gates convention,
# so no change to the machine-parsed Phase-graph table is needed.
phase_size() {  # phase_size <phase>  → echoes S|M|L
  local s
  s="$(grep -A8 "^### Phase ${1}\b" "$plan_file" 2>/dev/null \
        | grep -iE '^[[:space:]]*[-*].*[Ss]ize' \
        | sed -E 's/.*[Ss]ize[^A-Za-z]*([A-Za-z]).*/\1/' \
        | head -1 | tr '[:lower:]' '[:upper:]' || true)"
  case "$s" in S|M|L) echo "$s" ;; *) echo M ;; esac
}

# Live status of a phase from its handoff frontmatter.
# done | in-progress | stuck | not-started
phase_status() {  # phase_status <phase>
  local pad f st
  pad="$(printf '%02d' "$1")"
  f="$(ls "$handoff_dir"/phase-"${pad}"-*.md 2>/dev/null | head -1 || true)"
  [ -z "$f" ] && { echo not-started; return; }
  st="$(grep -m1 '^status:' "$f" | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
  case "$st" in
    complete)    echo "done" ;;
    in-progress) echo in-progress ;;
    blocked)     echo stuck ;;
    *)           echo not-started ;;
  esac
}

# ---------------------------------------------------------------------------
# Load the graph + live status into parallel arrays.
# ---------------------------------------------------------------------------
# Indexed arrays keyed by phase NUMBER (phases are small ints) — keeps this
# compatible with bash 3.2 (macOS /bin/bash), which lacks associative arrays.
declare -a PHASES=()
declare -a DEPS=() TITLE=() STATUS=() GATED=() SIZE=() REPOS=()
while IFS=$'\037' read -r ph deps title repos; do
  [ -z "$ph" ] && continue
  PHASES+=("$ph")
  DEPS["$ph"]="$deps"
  TITLE["$ph"]="$title"
  STATUS["$ph"]="$(phase_status "$ph")"
  GATED["$ph"]="$(is_gated "$ph")"
  SIZE["$ph"]="$(phase_size "$ph")"
  # Scope, normalized once here so every consumer sees the same csv. A phase
  # that named no repos gets `all` — it might touch anything, so it runs alone.
  REPOS["$ph"]="$(scope_of_row "$repos")"
done < <(parse_table)

if [ "${#PHASES[@]}" -eq 0 ]; then
  printf 'ERROR: could not parse a "## Phase graph" table in %s\n' "$plan_file" >&2
  printf '  The engine needs the standard table (Phase | Title | Depends on | …).\n' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Structural validation helpers (F1/F2/F3) + plan model (F6).
# (Reference _in_list, defined below — fine, these run only after full load.)
# ---------------------------------------------------------------------------
ALL_PHASES=" ${PHASES[*]} "          # space-padded set for _in_list membership

# F1: phase cells that contain a digit but are not a bare integer ("2a",
# "6 (gated)") are silently dropped by parse_table — find them so we can name them.
find_malformed() {
  # Same Phase-graph-table scoping as parse_table — only flag bad cells INSIDE
  # the phase table, never rows of other pipe tables in the plan.
  sed 's/–/-/g; s/—/-/g' "$plan_file" | awk -F'|' '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    tolower($0) ~ /^##[[:space:]]+phase graph/ { inpg=1; seen=0; next }
    inpg && seen && $0 !~ /^[[:space:]]*\|/ { inpg=0 }
    inpg && /^[[:space:]]*\|/ {
      seen=1
      ph = trim($2); gsub(/[*`]/, "", ph); ph = trim(ph)
      if (ph ~ /[0-9]/ && ph !~ /^[0-9]+$/) print ph
    }'
}

# F2: deps that reference a phase number not present in the table.
undefined_deps() {
  local p d
  for p in "${PHASES[@]}"; do
    for d in ${DEPS[$p]:-}; do
      _in_list "$d" "$ALL_PHASES" || printf 'phase %s depends on undefined phase %s\n' "$p" "$d"
    done
  done
  return 0
}

# F3: cycle detection (DFS, white/gray/black colouring). Sets CYCLE_PATH on hit.
declare -a COLOR=()
CYCLE_PATH=""
_dfs() {  # _dfs <node> <path-so-far> ; returns 0 (true) when a cycle is found
  local n="$1" path="$2 $1" d
  COLOR[$n]=1
  for d in ${DEPS[$n]:-}; do
    _in_list "$d" "$ALL_PHASES" || continue          # ignore undefined deps here
    if [ "${COLOR[$d]:-0}" = 1 ]; then CYCLE_PATH="${path# } -> $d"; return 0; fi
    if [ "${COLOR[$d]:-0}" = 0 ]; then
      if _dfs "$d" "$path"; then return 0; fi
    fi
  done
  COLOR[$n]=2
  return 1
}
detect_cycle() {  # returns 0 (true) if the dependency graph has a cycle
  CYCLE_PATH=""; COLOR=()
  local p
  for p in "${PHASES[@]}"; do COLOR[$p]=0; done
  for p in "${PHASES[@]}"; do
    if [ "${COLOR[$p]}" = 0 ]; then
      if _dfs "$p" ""; then return 0; fi
    fi
  done
  return 1
}

# All structural problems, one per line (empty output = clean).
compute_issues() {
  find_malformed | while IFS= read -r c; do
    [ -n "$c" ] && printf 'malformed Phase cell: %s (not an integer phase number)\n' "$c"
  done
  undefined_deps
  if detect_cycle; then printf 'dependency cycle: %s\n' "$CYCLE_PATH"; fi
  gate_issues
  return 0
}

# Gate-check grammar. The evaluator falls back to `manual` for anything it does
# not recognise, which is fail-safe but silent — so `Gate-check: phase-21 …`
# (hyphen, not space) read as manual and nobody knew the automation was off.
# Every deviation is reported here instead.
gate_issues() {
  local p gc gtype gval q
  for p in "${PHASES[@]}"; do
    gc="$(gate_check_directive "$p")"
    [ -z "$gc" ] && continue

    if [ "${GATED[$p]:-no}" != yes ]; then
      printf 'phase %s: has a Gate-check but the heading is not marked *(GATED)* — the board will batch it as ungated\n' "$p"
    fi

    gtype="${gc%% *}"; gval="${gc#"$gtype"}"; gval="${gval# }"
    if ! _gate_type_known "$gtype"; then
      printf 'phase %s: unknown Gate-check type "%s" (expected one of: %s) — it will be treated as manual\n' \
        "$p" "$gtype" "$GATE_TYPES"
      continue
    fi
    [ "$gtype" != manual ] && [ -z "$gval" ] && \
      printf 'phase %s: Gate-check type "%s" has no value\n' "$p" "$gtype"

    case "$gtype" in
      phase|phases)
        for q in $(printf '%s' "$gval" | tr ',' ' '); do
          case "$q" in ''|*[!0-9]*) printf 'phase %s: Gate-check %s references "%s", which is not a phase number\n' "$p" "$gtype" "$q"; continue ;; esac
          case " ${PHASES[*]} " in *" $q "*) ;; *) printf 'phase %s: Gate-check %s references phase %s, which is not in this plan\n' "$p" "$gtype" "$q" ;; esac
          [ "$q" = "$p" ] && printf 'phase %s: Gate-check %s references itself\n' "$p" "$gtype"
        done ;;
      plan)
        case "$gval" in
          *:*) [ -f "$DOCS_ROOT/docs/plans/${gval%%:*}.md" ] || \
                 printf 'phase %s: Gate-check plan references "%s", which has no docs/plans entry\n' "$p" "${gval%%:*}" ;;
          *)   printf 'phase %s: Gate-check plan must be <slug>:<phases>, got "%s"\n' "$p" "$gval" ;;
        esac ;;
      date|deadline|by)
        _valid_date "$gval" || \
          printf 'phase %s: Gate-check %s needs a real YYYY-MM-DD date, got "%s"\n' "$p" "$gtype" "$gval" ;;
      cmd)
        printf '%s' "$gval" | grep -qE "$GATE_CMD_DENY" && \
          printf 'phase %s: Gate-check cmd looks like it mutates state — a gate must only observe: %s\n' "$p" "$gval" ;;
    esac
  done
  return 0
}

# F6: model named in the plan's "## Session budget" section (empty if none).
plan_model() {
  awk 'tolower($0) ~ /^##[[:space:]]+session budget/{f=1;next} /^##[[:space:]]/{f=0} f' "$plan_file" \
    | grep -ioE 'haiku|opus|sonnet|fable|mythos' | head -1 | tr '[:upper:]' '[:lower:]'
}

# Skills directive: backtick-quoted skill names on the canonical
# "**Skills (every session):**" line in the plan's "## Session budget" section — the
# skills EVERY session in this plan must invoke. Re-injected into every boot prompt +
# the QA brief so a cold-start session re-activates them (e.g. `design-system`,
# `some-plugin:test-first`). Empty if none. ONLY that exact phrase
# matches — a loose 'skill' match would swallow backticked tokens from unrelated
# budget prose (e.g. "skill v3 sizing — `claude-opus-5`") into the skills list.
plan_skills() {
  # `|| true`: a no-match grep mid-pipe exits 1, which under `set -euo pipefail`
  # would otherwise abort every caller (e.g. --boot-prompt) on a plan with no Skills line.
  awk 'tolower($0) ~ /^##[[:space:]]+session budget/{f=1;next} /^##[[:space:]]/{f=0} f' "$plan_file" \
    | grep -i 'skills (every session)' | grep -oE '`[^`]+`' | tr -d '`' | paste -sd ',' - | sed 's/,/, /g' || true
}

# done-set override hook: --ready-after N treats N as already done.
assume_done="${arg:-}"
_is_done() {  # _is_done <phase>  (respects the assume-done override)
  [ "$1" = "$assume_done" ] && { return 0; }
  [ "${STATUS[$1]:-not-started}" = "done" ]
}

# ---- QA verification gate (Task 6) ----------------------------------------
# When docs/handoffs/<slug>/test-status.md exists, dependents are gated on their
# deps being QA-VERIFIED (handoff complete AND QA result pass|waived), not merely
# done. No test-status.md → gating off → behaviour identical to before.
qa_status_file="$DOCS_ROOT/docs/handoffs/${slug}/test-status.md"
QA_GATING=0
[ -f "$qa_status_file" ] && QA_GATING=1
qa_result() {  # qa_result <phase> → pass|fail|pending|waived|none  (from the "## QA status" table)
  [ -f "$qa_status_file" ] || { echo none; return; }
  sed 's/–/-/g; s/—/-/g' "$qa_status_file" | awk -F'|' -v want="$1" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    tolower($0) ~ /^##[[:space:]]+qa status/ { inq=1; seen=0; next }
    inq && seen && $0 !~ /^[[:space:]]*\|/ { inq=0 }
    inq && /^[[:space:]]*\|/ {
      seen=1; ph=trim($2); gsub(/[*`]/,"",ph); ph=trim(ph)
      if (ph != want) next
      print tolower(trim($3)); found=1; exit
    }
    END { if (!found) print "none" }
  '
}
_is_verified() {  # done + QA-passed (when gating on); honours the assume-done hook
  [ "$1" = "$assume_done" ] && return 0
  _is_done "$1" || return 1
  [ "$QA_GATING" = 0 ] && return 0
  case "$(qa_result "$1")" in pass|waived) return 0 ;; *) return 1 ;; esac
}

# ---- QA mode (v3: QA subagents are OPT-IN, off by default) -----------------
# Resolution order (first hit wins):
#   1. canonical "**QA gate:** off" in plan §Session budget → "waived …" (record
#      rows as waived, NEVER dispatch a QA subagent; existing fail rows still gate)
#   2. canonical "**QA gate:** on"                          → "on …" (dispatch at finish)
#   3. legacy waiver prose (a "QA gate" line containing "waiv") → "waived …"
#   4. test-status.md already exists (legacy/back-compat)   → "on …"
#   5. none of the above                                    → "off" (no QA artifact)
# The canonical grep is line-anchored and bold-EXACT ("**QA gate:** on") so prose
# like "**QA gate: WAIVED for ALL phases** (user decision…" can never match "on".
session_budget_block() {
  awk 'tolower($0) ~ /^##[[:space:]]+session budget/{f=1;next} /^##[[:space:]]/{f=0} f' "$plan_file"
}
qa_mode() {
  local sb; sb="$(session_budget_block)"
  if printf '%s\n' "$sb" | grep -qiE '^[[:space:]>]*\*\*QA gate:\*\*[[:space:]]*off[[:space:]]*$'; then
    echo "waived (plan directive: QA gate: off)"; return
  fi
  if printf '%s\n' "$sb" | grep -qiE '^[[:space:]>]*\*\*QA gate:\*\*[[:space:]]*on[[:space:]]*$'; then
    echo "on (plan directive: QA gate: on)"; return
  fi
  if printf '%s\n' "$sb" | grep -i 'qa gate' | grep -qi 'waiv'; then
    echo "waived (plan waiver directive)"; return
  fi
  if [ -f "$qa_status_file" ]; then
    echo "on (test-status.md exists)"; return
  fi
  echo "off"
}

# Dependencies of <phase> not yet satisfied: not done, or — with QA gating on —
# done but not yet QA-verified. Space-separated, may be empty.
missing_deps() {  # missing_deps <phase>
  local d out=""
  for d in ${DEPS[$1]:-}; do
    _is_verified "$d" || out="$out $d"
  done
  echo "${out# }"
}

# Compute a phase's runtime state (pure — no globals, safe across $(…) subshells).
# done|in-progress|stuck|ready|waiting
phase_state() {  # phase_state <phase>
  local p="$1" st="${STATUS[$1]:-not-started}"
  if _is_done "$p"; then echo "done"; return; fi
  [ "$st" = in-progress ] && { echo in-progress; return; }
  [ "$st" = stuck ] && { echo stuck; return; }
  [ -z "$(missing_deps "$p")" ] && echo ready || echo waiting
}

# ---------------------------------------------------------------------------
# Batch grouping: which SEQUENTIAL phases can share one session.
# Concurrency is orthogonal — independent ready phases fan out to separate
# sessions; only phases on the same dependency chain are ever batched.
# ---------------------------------------------------------------------------
HAVE_SIZES=0
grep -qiE '^[[:space:]]*[-*].*[Ss]ize' "$plan_file" 2>/dev/null && HAVE_SIZES=1

_in_list() {  # _in_list <needle> <space-list>
  case " ${2} " in *" ${1} "*) return 0 ;; *) return 1 ;; esac
}
_deps_subset_of() {  # every dep of <phase> is in <set>
  local d
  for d in ${DEPS[$1]:-}; do _in_list "$d" "$2" || return 1; done
  return 0
}
_deps_intersect() {  # at least one dep of <phase> is in <set>
  local d
  for d in ${DEPS[$1]:-}; do _in_list "$d" "$2" && return 0; done
  return 1
}
_size_weight() {  # token estimate for S|M|L — values from sizing.env (F5)
  case "$1" in S) echo "$SIZE_S" ;; L) echo "$SIZE_L" ;; *) echo "$SIZE_M" ;; esac
}
resolve_budget() {  # model alias OR raw token number → per-session budget (F5)
  local a; a="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [ -z "$a" ] && { echo "$BUDGET_DEFAULT"; return; }
  case "$a" in
    *[!0-9]*) : ;;                 # has a non-digit → treat as a model alias below
    *)        echo "$a"; return ;; # all digits → use verbatim
  esac
  case "$a" in
    *haiku*)                          echo "$BUDGET_HAIKU" ;;
    *opus*|*sonnet*|*fable*|*mythos*) echo "$BUDGET_BIG" ;;
    *)                                echo "$BUDGET_DEFAULT" ;;
  esac
}
# Greedy grouping over the REMAINING (not done / not in-flight) phases in table
# order — v3: the old tip-dependency and fan-out≤1 rules are gone. Parallel-safe
# siblings and L phases batch like anything else (execution inside a session is
# serial); only these cut a session:
#   • an unmet dependency (deps must all be in done_before or in the group),
#   • a GATED phase (external gates never get batched past — always its own
#     session, and nothing joins after it),
#   • QA gating (when on, a phase never shares a session with a dependency —
#     the dep's verdict must be recorded before the dependent starts),
#   • the summed weight exceeding the budget.
# done_before is seeded from the LIVE done-set so mid-plan suggestions are real;
# in-progress/stuck phases are excluded (they're already being handled).
# A phase may START a group only when its deps are all in done_before; otherwise
# it opens a SEALED solo group (nothing may join it — prevents ordering
# inversions when the table lists a phase before its own dependency) and is then
# treated as done so downstream grouping can continue.
# Echoes "p p|p|p p" (groups by |) — pure phase numbers; flags are computed by
# the printers.
compute_groups() {  # compute_groups <budget>
  local budget="$1" done_before=" " cur="" cur_w=0 cur_sealed=0 out="" p w st
  for p in "${PHASES[@]}"; do
    st="${STATUS[$p]:-not-started}"
    if [ "$st" = "done" ]; then done_before="${done_before}${p} "; continue; fi
    if [ "$st" = in-progress ] || [ "$st" = stuck ]; then continue; fi
    w="$(_size_weight "${SIZE[$p]:-M}")"
    if [ -n "$cur" ] \
       && [ "$cur_sealed" = 0 ] \
       && [ "${GATED[$p]:-no}" != yes ] \
       && _deps_subset_of "$p" "${done_before}${cur} " \
       && { [ "$QA_GATING" = 0 ] || ! _deps_intersect "$p" " ${cur} "; } \
       && [ $((cur_w + w)) -le "$budget" ]; then
      cur="$cur $p"; cur_w=$((cur_w + w))
    else
      if [ -n "$cur" ]; then out="${out}${out:+|}${cur}"; done_before="${done_before}${cur} "; fi
      cur="$p"; cur_w="$w"; cur_sealed=0
      [ "${GATED[$p]:-no}" = yes ] && cur_sealed=1
      _deps_subset_of "$p" "$done_before" || cur_sealed=1
    fi
  done
  [ -n "$cur" ] && out="${out}${out:+|}${cur}"
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Machine sub-commands.
# ---------------------------------------------------------------------------
case "$mode" in
  --plan-status)
    # The stored operator decision, normalised. Always one bare word.
    printf '%s\n' "$PLAN_STATUS"
    exit 0
    ;;
  --closed)
    # The predicate every other script shells out to, so closure is read in exactly
    # one place. 0 = closed, 1 = open.
    if plan_is_closed; then printf 'closed %s\n' "$PLAN_STATUS"; exit 0; fi
    printf 'open %s\n' "$PLAN_STATUS"; exit 1
    ;;
  --lint)
    # F1/F2/F3: structural validation. Exit non-zero on any problem.
    issues="$(compute_issues)"
    declared="$(grep -m1 '^phases:' "$plan_file" | sed 's/^phases:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
    if [ -n "$declared" ] && [ "$declared" != TODO ] && [ "$declared" != "${#PHASES[@]}" ]; then
      issues="${issues}"$'\n'"phase count mismatch: frontmatter says ${declared} but the table parses ${#PHASES[@]} rows"
    fi
    issues="$(printf '%s' "$issues" | sed '/^[[:space:]]*$/d')"
    if [ -n "$issues" ]; then
      # A closed plan still gets its problems named — they just stop being a gate.
      # Nobody should have to repair a plan they have already walked away from.
      if plan_is_closed; then
        printf '%s\n' "$issues" >&2
        printf 'LINT OK (closed): %s — %s issue[s] noted, not gating\n' "$slug" "$(printf '%s\n' "$issues" | grep -c .)"
        exit 0
      fi
      printf '%s\n' "$issues" >&2
      printf 'LINT FAIL: %s (%s issue[s])\n' "$slug" "$(printf '%s\n' "$issues" | grep -c .)" >&2
      exit 1
    fi
    if plan_is_closed; then
      printf 'LINT OK (closed): %s — %s phases, well-formed and acyclic\n' "$slug" "${#PHASES[@]}"
      exit 0
    fi
    printf 'LINT OK: %s — %s phases, well-formed and acyclic\n' "$slug" "${#PHASES[@]}"
    exit 0
    ;;
  --ready|--ready-after)
    # A closed plan offers no work: nothing is ready, so nothing gets started or
    # batched and no boot prompt is ever generated for it.
    plan_is_closed && { echo ""; exit 0; }
    # --ready-after N already set assume_done=arg above (arg is the 3rd positional).
    out=""
    for p in "${PHASES[@]}"; do
      [ "$p" = "$assume_done" ] && continue
      [ "$(phase_state "$p")" = ready ] && out="$out $p"
    done
    echo "${out# }"
    exit 0
    ;;
  --dependents)
    [ -z "$arg" ] && { echo "usage: --dependents <phase>" >&2; exit 2; }
    out=""
    for p in "${PHASES[@]}"; do
      for d in ${DEPS[$p]}; do
        [ "$d" = "$arg" ] && out="$out $p"
      done
    done
    echo "${out# }"
    exit 0
    ;;
  --deps)
    [ -z "$arg" ] && { echo "usage: --deps <phase>" >&2; exit 2; }
    echo "${DEPS[$arg]:-}"
    exit 0
    ;;
  --gated)
    [ -z "$arg" ] && { echo "usage: --gated <phase>" >&2; exit 2; }
    echo "${GATED[$arg]:-no}"
    exit 0
    ;;
  --repos)
    # The phase's SCOPE: what it touches, from the plan's Repos column, as the
    # csv `phase-lock.sh --scope` and `conflicts` speak. Never empty — an
    # undeclared phase reads as `all`, which collides with everything.
    [ -z "$arg" ] && { echo "usage: --repos <phase>" >&2; exit 2; }
    echo "${REPOS[$arg]:-all}"
    exit 0
    ;;
  --qa-result)
    [ -z "$arg" ] && { echo "usage: --qa-result <phase>" >&2; exit 2; }
    qa_result "$arg"
    exit 0
    ;;
  --qa-mode)
    # "waived <reason>" | "on <reason>" | "off" — whether phase-finish dispatches
    # a QA subagent (on), records waived rows without dispatching (waived), or
    # skips the QA artifact entirely (off, the default).
    qa_mode
    exit 0
    ;;
  --qa-prompt)
    # Fresh-context QA-subagent brief for a just-finished phase (QA-on plans only —
    # QA is opt-in since v3; check --qa-mode first). The phase-finish step dispatches
    # THIS as an Agent subagent (clean context = independent review) — it is NOT a
    # separate user-invoked skill. Paths resolve via $SCRIPT_DIR / the skill root so the
    # brief is correct from any account/clone (F13).
    [ -z "$arg" ] && { echo "usage: --qa-prompt <phase>" >&2; exit 2; }
    p="$arg"; pad="$(printf '%02d' "$p")"
    skill_root="$(cd "$SCRIPT_DIR/.." && pwd)"
    hf="$(ls "$handoff_dir"/phase-"${pad}"-*.md 2>/dev/null | head -1 || true)"
    [ -n "$hf" ] && hf_rel="docs/handoffs/${slug}/$(basename "$hf")" || hf_rel="docs/handoffs/${slug}/phase-${pad}-*.md"
    printf 'You are an INDEPENDENT QA reviewer with a FRESH context. Verify Phase %s of "%s" before\n' "$p" "$slug"
    printf 'its dependents start. Do NOT trust the handoff'\''s claims — establish ground truth yourself\n'
    printf 'from the plan + the real diff.\n\n'
    sk="$(plan_skills)"
    [ -n "$sk" ] && printf 'First invoke these skills (the plan uses them for every session): %s\n\n' "$sk"
    printf -- '1. `git pull`. Read docs/plans/%s.md §Phase %s — goal, exit criteria, Verification.\n' "$slug" "$p"
    printf -- '2. Read the handoff %s (its claims + key_files), then read ALL code the phase changed\n' "$hf_rel"
    printf '   COLD: `git diff` of its commits + every key_files path, in full.\n'
    printf -- '3. Investigate for gaps/bugs/regressions/security per %s/references/qa-method.md —\n' "$skill_root"
    printf '   a real review, not just tests. Run and extend tests to cover every exit criterion.\n'
    printf -- '4. Write the report from %s/assets/report-template.md to\n' "$skill_root"
    printf -- '   docs/handoffs/%s/reports/phase-%s-qa.md, then record the verdict:\n' "$slug" "$pad"
    printf '     bash %s/qa-record.sh %s %s <pass|fail|waived> --report reports/phase-%s-qa.md\n' "$SCRIPT_DIR" "$slug" "$p" "$pad"
    printf -- '5. Commit + push the report + test-status.md, then return the verdict + findings\n'
    printf '   (dependents unblock only once pass|waived; a fail must be pushed to gate them).\n'
    exit 0
    ;;
  --gate-status)
    # F12: evaluate a phase's machine-checkable gate. Exit 0 = clear, 1 = blocked/manual.
    [ -z "$arg" ] && { echo "usage: --gate-status <phase>" >&2; exit 2; }
    gc="$(gate_check_directive "$arg")"
    if [ -z "$gc" ]; then
      if [ "$(is_gated "$arg")" = yes ]; then printf 'manual: %s\n' "$(gate_conditions "$arg")"; exit 1; fi
      echo "clear (no gate)"; exit 0
    fi
    gtype="${gc%% *}"; gval="${gc#"$gtype"}"; gval="${gval# }"
    case "$gtype" in
      phase)
        if _is_verified "$gval"; then echo "clear (phase $gval verified)"; exit 0
        else echo "blocked: waiting on phase $gval"; exit 1; fi ;;
      phases)
        # Several phases of THIS plan, comma- or space-separated. One `phase`
        # gate could not express "6,7,8,9,11,13,16,17,18", so plans wrote that
        # as prose and lost the automation.
        missing=""
        for q in $(printf '%s' "$gval" | tr ',' ' '); do
          case "$q" in ''|*[!0-9]*) continue ;; esac
          _is_verified "$q" || missing="$missing $q"
        done
        if [ -z "$missing" ]; then echo "clear (phases $gval verified)"; exit 0
        else echo "blocked: waiting on phase(s)$missing"; exit 1; fi ;;
      plan)
        # Cross-plan: "<slug>:<phases>". Plans really do gate on each other and
        # the graph had no way to say so.
        if _gate_plan "$gval"; then exit 0; else exit 1; fi ;;
      cmd)
        # A fact about the world, asserted by a command. See _gate_cmd — off
        # unless PHASE_EXEC_GATES=1.
        if _gate_cmd "$gval"; then exit 0; else exit 1; fi ;;
      date)
        _valid_date "$gval" || { echo "manual: not a valid date: $gval"; exit 1; }
        today="$(date +%F)"; ti="${today//-/}"; gi="${gval//-/}"
        if [ "$ti" -ge "$gi" ]; then echo "clear (date $gval reached)"; exit 0
        else echo "blocked: opens on $gval (today $today)"; exit 1; fi ;;
      deadline|by)
        _valid_date "$gval" || { echo "manual: not a valid date: $gval"; exit 1; }
        today="$(date +%F)"; ti="${today//-/}"; gi="${gval//-/}"
        if [ "$ti" -gt "$gi" ]; then echo "OVERDUE: deadline $gval passed (today $today)"; exit 1
        else echo "clear (before deadline $gval)"; exit 0; fi ;;
      manual) echo "manual: $gval"; exit 1 ;;
      *)      echo "manual: $gc"; exit 1 ;;
    esac
    ;;
  --memory-block)
    # F9: canonical phase-status block for the project_<slug> memory (no drift).
    md_d=""; md_ip=""; md_st=""; md_rd=""; md_wt=""
    for p in "${PHASES[@]}"; do
      case "$(phase_state "$p")" in
        done)        md_d="$md_d $p" ;;
        in-progress) md_ip="$md_ip $p" ;;
        stuck)       md_st="$md_st $p" ;;
        ready)       md_rd="$md_rd $p" ;;
        waiting)     md_wt="$md_wt $p" ;;
      esac
    done
    _csv() { echo "${1# }" | sed 's/ /, /g'; }
    if plan_is_closed; then
      printf 'closed: %s' "$PLAN_STATUS"
      [ -n "$PLAN_CLOSED_ON" ] && printf ' %s' "$PLAN_CLOSED_ON"
      [ -n "$PLAN_CLOSED_REASON" ] && printf ' — %s' "$PLAN_CLOSED_REASON"
      printf '\n'
    fi
    printf 'done: %s\n' "$(_csv "$md_d")"
    [ -n "$md_ip" ] && printf 'in-progress: %s\n' "$(_csv "$md_ip")"
    [ -n "$md_st" ] && printf 'stuck: %s\n' "$(_csv "$md_st")"
    printf 'ready: %s\n' "$(_csv "$md_rd")"
    printf 'waiting: %s\n' "$(_csv "$md_wt")"
    exit 0
    ;;
  --size)
    [ -z "$arg" ] && { echo "usage: --size <phase>" >&2; exit 2; }
    echo "${SIZE[$arg]:-M}"
    exit 0
    ;;
  --session-plan)
    if plan_is_closed; then
      printf '\nSession plan — %s\n\n' "$slug"
      closed_banner
      printf '\nNo sessions to plan.\n'
      exit 0
    fi
    budget="$(resolve_budget "$arg")"
    printf '\nSession plan — %s   (budget ~%sK/session · S=%sK M=%sK L=%sK)\n' "$slug" "$((budget / 1000))" "$((SIZE_S / 1000))" "$((SIZE_M / 1000))" "$((SIZE_L / 1000))"
    printf 'Suggestion only: remaining phases share a session while deps are met and weight fits;\n'
    printf 'GATED phases, QA boundaries, and the budget cut. Confirm against your live context meter.\n'
    [ "$HAVE_SIZES" = 1 ] || printf '(no "Size:" tags found — every phase treated as M; add them for sharper batches)\n'
    printf '\n'
    live_done=""
    for q in "${PHASES[@]}"; do [ "${STATUS[$q]:-}" = "done" ] && live_done="$live_done $q"; done
    [ -n "$live_done" ] && printf '  (already done, excluded:%s)\n' "$(echo "$live_done" | sed 's/ /, /g; s/^,//')"
    compute_groups "$budget" | tr '|' '\n' | {
      gi=0; seen=" ${live_done# } "
      while IFS= read -r g || [ -n "$g" ]; do
        g="$(echo $g)"                       # trim surrounding whitespace
        [ -z "$g" ] && continue
        gi=$((gi + 1))
        gw=0; for q in $g; do gw=$((gw + $(_size_weight "${SIZE[$q]:-M}"))); done
        np="$(set -- $g; echo $#)"
        flags=""
        first="${g%% *}"
        miss=""
        for d in ${DEPS[$first]:-}; do _in_list "$d" "$seen" || miss="$miss $d"; done
        [ -n "$miss" ] && flags="$flags  ⚠ waiting on:${miss}"
        ggat=no; for q in $g; do [ "${GATED[$q]:-no}" = yes ] && ggat=yes; done
        [ "$ggat" = yes ] && flags="$flags  🔒 GATED — own session, confirm gates first"
        [ "$gw" -gt "$budget" ] && flags="$flags  ⚠ over budget — split"
        if [ "$np" -gt 1 ]; then
          printf '  Session %s  batch  (~%sK):  %s%s\n' "$gi" "$((gw / 1000))" "$(echo $g | sed 's/  */ → /g')" "$flags"
        else
          printf '  Session %s  solo   (~%sK):  Phase %s%s\n' "$gi" "$((gw / 1000))" "$g" "$flags"
        fi
        seen="${seen}${g} "
      done
    }
    printf '\n'
    exit 0
    ;;
  --boot-prompt)
    [ -z "$arg" ] && { echo "usage: --boot-prompt <phase>" >&2; exit 2; }
    p="$arg"
    # Read-first context = the handoffs of THIS phase's dependencies (what it builds
    # on), not merely the most recent phase — a DAG phase may build on a low-numbered
    # prerequisite while higher-numbered siblings are still unwritten.
    dep_lines=""
    for d in ${DEPS[$p]}; do
      pad="$(printf '%02d' "$d")"
      hf="$(ls "$handoff_dir"/phase-"${pad}"-*.md 2>/dev/null | head -1 || true)"
      [ -n "$hf" ] && dep_lines="${dep_lines}- docs/handoffs/${slug}/$(basename "$hf")"$'\n'
    done
    printf '/phased-execution\n\n'
    printf 'Continue the "%s" plan — start Phase %s in this fresh session.\n' "$slug" "$p"
    sk="$(plan_skills)"
    [ -n "$sk" ] && printf 'First, invoke these skills (every session in this plan uses them): %s\n' "$sk"
    if [ "${GATED[$p]}" = yes ]; then
      gc="$(gate_conditions "$p")"
      if [ -n "$gc" ]; then
        printf '⚠️  GATED phase — confirm these gates are cleared before implementing: %s\n' "$gc"
      else
        printf '⚠️  GATED phase — confirm external gates are cleared first (see plan §Phase %s).\n' "$p"
      fi
    fi
    printf 'Bootstrap from disk only:\n'
    [ -n "$dep_lines" ] && printf '%s' "$dep_lines"
    printf -- '- docs/plans/%s.md §Phase %s + §Session budget (model, budget, branch)\n' "$slug" "$p"
    printf -- '- memory %s\n' "$memory_key"
    printf 'This is a DAG: other phases may be ready too and lower-numbered phases may still be\n'
    printf 'unfinished — do NOT assume phases below %s are done. Run `scripts/phase-graph.sh %s`\n' "$p" "$slug"
    printf 'for live state.\n'
    sc="${REPOS[$p]:-all}"
    printf '\nThis phase'\''s SCOPE (the repos it touches, from the plan'\''s Repos column): %s\n' "$sc"
    printf 'Two sessions may run at once ONLY on disjoint scopes. Before implementing:\n'
    printf -- '  1. `git pull`, then check nothing live shares your tree:\n'
    printf -- '       bash %s/phase-lock.sh %s conflicts %s --scope "%s" --git\n' "$SCRIPT_DIR" "$slug" "$p" "$sc"
    printf -- '     A reported conflict means STOP AND ASK the user — never build over a live session.\n'
    printf -- '  2. Claim it:\n'
    printf -- '       bash %s/phase-lock.sh %s claim %s --scope "%s" --git\n' "$SCRIPT_DIR" "$slug" "$p" "$sc"
    printf -- '     (--owner defaults to $PE_OWNER, which the autopilot already exports to its\n'
    printf -- '      sessions — do not override it, or the supervisor cannot release your lock.\n'
    printf -- '      Only a person driving this by hand should pass --owner "<account>/<session>".)\n'
    printf 'The invariant: never two live sessions whose scopes intersect; same repo ⇒ serialized;\n'
    printf '`all` ⇒ exclusive; disjoint ⇒ parallel. (Handoff/lock commits in the docs repo are NOT\n'
    printf 'part of your scope — if a commit or pull races another session, pull --rebase and retry\n'
    printf 'up to 3 times; git'\''s own index.lock is the serialization there.)\n'
    printf '\nThen build the p%s.task* list and implement Phase %s to its exit criteria.\n' "$p" "$p"
    printf 'Stop + hand off when done.\n'
    exit 0
    ;;
  board) ;;  # fall through to the human board
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# Default: human status board.
# ---------------------------------------------------------------------------
done_n=0
for p in "${PHASES[@]}"; do [ "${STATUS[$p]}" = "done" ] && done_n=$((done_n + 1)); done
total="${#PHASES[@]}"

printf '\nPhase graph — %s   (%s/%s done)\n' "$slug" "$done_n" "$total"

# A closed plan keeps its whole board — closing quiets a plan, it never hides one —
# but the banner goes first so nobody mistakes the phase lines for outstanding work.
if plan_is_closed; then
  printf '\n'
  closed_banner
fi

# Reconcile parsed rows against the plan's declared phase count — a mismatch means
# the table is malformed (e.g. a phase number wrapped oddly) and the board may mislead.
declared="$(grep -m1 '^phases:' "$plan_file" | sed 's/^phases:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
if [ -n "$declared" ] && [ "$declared" != TODO ] && [ "$declared" != "$total" ]; then
  if plan_is_closed; then
    printf 'ℹ️  note: frontmatter says phases: %s but the table parsed %s rows.\n' "$declared" "$total"
  else
    printf '⚠️  plan frontmatter says phases: %s but the table parsed %s rows — check the\n' "$declared" "$total"
    printf '    "## Phase graph" table for a row the parser skipped (odd phase-number formatting).\n'
  fi
fi
# F1/F2/F3: surface structural problems by name instead of silently misleading.
# On a closed plan they stay visible — a broken plan must never become invisible —
# but demoted to a note, because nobody owes repairs to a plan they have closed.
_issues="$(compute_issues)"
if [ -n "$_issues" ]; then
  if plan_is_closed; then
    printf 'ℹ️  structural notes (not gating — this plan is closed):\n'
    printf '%s\n' "$_issues" | sed 's/^/      • /'
  else
    printf '⚠️  STRUCTURE PROBLEMS — fix these; the board below may be wrong until you do:\n'
    printf '%s\n' "$_issues" | sed 's/^/      • /'
  fi
fi
echo

ready_list=""; waiting_list=""; inprog_list=""
for p in "${PHASES[@]}"; do
  state="$(phase_state "$p")"
  gmark=""; [ "${GATED[$p]}" = yes ] && gmark=" 🔒GATED"
  case "$state" in
    done)        icon="✅"; extra=""
                 if [ "$QA_GATING" = 1 ] && ! plan_is_closed; then
                   case "$(qa_result "$p")" in
                     pass|waived) extra=" · QA:verified" ;;
                     fail)        extra=" · QA:FAILED" ;;
                     *)           extra=" · QA:pending" ;;
                   esac
                 fi ;;
    in-progress) icon="🚧"; extra=""; inprog_list="$inprog_list $p" ;;
    stuck)       icon="⛔"; extra=" (handoff status: blocked)"; inprog_list="$inprog_list $p" ;;
    ready)       icon="🔓"; extra=""; ready_list="$ready_list $p" ;;
    waiting)     miss="$(missing_deps "$p")"; icon="⏳"; extra=" needs: ${miss}"
                 waiting_list="$waiting_list $p(←${miss// /,})" ;;
  esac
  printf '  %s  %-2s %-12s %s%s%s\n' "$icon" "$p" "$state" "${TITLE[$p]}" "$gmark" "$extra"
done

echo
# Everything below this line is a call to action — which is exactly what a closed
# plan must not issue. No ready work, no batching advice, no "finish me" nudge.
if plan_is_closed; then
  printf 'No work is outstanding on a closed plan.\n\n'
  exit 0
fi
[ -n "$ready_list" ]  && printf 'READY NOW:   %s\n' "$(echo "$ready_list" | sed 's/^ //')"
[ -n "$inprog_list" ] && printf 'IN PROGRESS: %s\n' "$(echo "$inprog_list" | sed 's/^ //')"
[ -n "$waiting_list" ]&& printf 'WAITING:     %s\n' "$(echo "$waiting_list" | sed 's/^ *//')"
if [ "$HAVE_SIZES" = 1 ]; then
  board_budget="$(resolve_budget "$(plan_model)")"   # F6: honour the plan's Session budget model
  batches="$(compute_groups "$board_budget" | sed 's/ /+/g; s/|/]  [/g')"
  printf 'SUGGESTED BATCHES (budget ~%sK, joined phases share a session): [%s]\n' "$((board_budget / 1000))" "$batches"
  printf '   model-specific grouping → scripts/phase-graph.sh %s --session-plan <model>\n' "$slug"
fi
if [ "$done_n" = "$total" ]; then
  printf '\n🏁 All %s phases done — run §End-to-end verification, then close the plan:\n' "$total"
  printf '   scripts/close-plan.sh %s --status complete --reason "<what shipped>"\n' "$slug"
elif [ -z "$ready_list" ] && [ -z "$inprog_list" ]; then
  printf '\n⚠️  Nothing ready and nothing in progress — every remaining phase is waiting on a dep.\n'
  printf '   Check the WAITING list above for a stuck/blocked dependency.\n'
fi
echo
