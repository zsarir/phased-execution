# shellcheck shell=bash
# Scope reading for phased-execution — the bash half of viewer/shared/scope.js.
#
# Sourced (never executed) by phase-lock.sh and phase-graph.sh so there is ONE
# bash reading of a plan's Repos column, not two that drift. The JavaScript half
# is viewer/shared/scope.js; viewer/test/engine-parity.test.ts holds the two
# against every real plan, which is the only thing that keeps them honest.
#
# The rules, kept small enough to be the same in awk and in JS:
#   - parenthetical asides come off first  — `api (+web snapshot)` is one repo
#   - `,` `+` and whitespace separate; a bare `and` is a conjunction, not a repo
#   - `/` never separates: `packages/cart-api` is the one path it looks like
#   - lowercase; only [a-z0-9._/-] survives; 2..64 characters
#   - `*` means `all`
#
# Intersection: `all` hits everything, equal hits, and a SEGMENT-WISE path prefix
# hits — `packages` ∩ `packages/cart-api`, but `api` ∩ `api-gateway` is disjoint.
# Unknown (either side empty) counts as a collision: a missed conflict lets two
# sessions write one working tree, a false one only costs parallelism.

# scope_normalize <cell> → normalized csv on stdout ('' for a cell with no repos)
scope_normalize() {
  printf '%s' "${1:-}" | awk '
    function norm(t,   s) {
      s = tolower(t)
      if (s == "*") return "all"
      if (s == "and") return ""          # a conjunction between repos
      gsub(/[^a-z0-9._\/-]/, "", s)
      while (s ~ /\/\//) sub(/\/\//, "/", s)
      sub(/^[^a-z0-9]+/, "", s)
      sub(/[^a-z0-9]+$/, "", s)
      if (length(s) < 2 || length(s) > 64) return ""
      return s
    }
    {
      line = $0
      gsub(/\([^)]*\)?/, " ", line)      # asides off before anything splits
      gsub(/[,+]/, " ", line)
      n = split(line, toks, /[ \t]+/)
      out = ""; seen = " "
      for (i = 1; i <= n; i++) {
        t = norm(toks[i])
        if (t == "") continue
        if (index(seen, " " t " ") > 0) continue
        seen = seen t " "
        out = (out == "" ? t : out "," t)
      }
      printf "%s", out
    }'
}

# scope_of_row <cell> → normalized csv, never empty (a phase that said nothing
# might touch anything, so it runs alone).
scope_of_row() {
  local s
  s="$(scope_normalize "${1:-}")"
  [ -n "$s" ] || s="all"
  printf '%s' "$s"
}

# scope_intersects <csv-a> <csv-b> → exit 0 if the two scopes overlap.
scope_intersects() {
  local a b
  # Either side unstated ⇒ assume they collide.
  [ -n "${1:-}" ] && [ -n "${2:-}" ] || return 0
  for a in $(printf '%s' "$1" | tr ',' ' '); do
    for b in $(printf '%s' "$2" | tr ',' ' '); do
      if [ "$a" = all ] || [ "$b" = all ]; then return 0; fi
      if [ "$a" = "$b" ]; then return 0; fi
      # Trailing slash on both sides is what makes the prefix segment-wise.
      case "$b/" in "$a"/*) return 0 ;; esac
      case "$a/" in "$b"/*) return 0 ;; esac
    done
  done
  return 1
}

# scope_overlap <csv-a> <csv-b> → the colliding tokens, space separated (for
# saying WHICH repo collided instead of only that something did).
scope_overlap() {
  local a b out=""
  for a in $(printf '%s' "${1:-}" | tr ',' ' '); do
    for b in $(printf '%s' "${2:-}" | tr ',' ' '); do
      scope_intersects "$a" "$b" || continue
      case " $out " in *" $a "*) continue ;; esac
      out="$out $a"
    done
  done
  printf '%s' "${out# }"
}
