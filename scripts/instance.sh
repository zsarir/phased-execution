# shellcheck shell=bash
# Instance identity for phased-execution — the bash half of the naming rule in
# viewer/shared/instances.mjs.
#
# Sourced (never executed) by phase-outcome.sh and session-hook.sh, which need
# to find Phase Console's state for the repository they are standing in WITHOUT
# a console answering and WITHOUT node: a human session declaring an outcome,
# a hook firing while the console is down. The rule must therefore be the same
# one `instanceId()` computes, or the console looks in one directory while the
# scripts write to another:
#
#   id        = sha256(<root path, as given — lexical, not realpath>)[:8] "-" basename(root)
#   state     = ${XDG_STATE_HOME:-~/.local/state}/phase-console
#   runs dir  = <state>/runs/<id>/<slug>            (shared across instances, keyed by id)
#   instance  = <state>                             for the default instance,
#               <state>/instances/<id>              for every other one
#
# The root is resolved exactly as phase-lock.sh resolves it: $DOCS_ROOT when set,
# else the git superproject / toplevel, else the working directory. bash 3.2.

# pe_state_home → the console's state home on stdout
pe_state_home() {
  printf '%s/phase-console' "${XDG_STATE_HOME:-$HOME/.local/state}"
}

# pe_instance_root → the repository root this session is working in
pe_instance_root() {
  local root="${DOCS_ROOT:-}"
  if [ -z "$root" ]; then
    root="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
    [ -n "$root" ] || root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  fi
  # Lexical normalisation only (`resolve()` in JS): absolute, no trailing slash.
  case "$root" in
    /) : ;;
    */) root="${root%/}" ;;
  esac
  case "$root" in
    /*) : ;;
    *) root="$(pwd)/$root" ;;
  esac
  printf '%s' "$root"
}

# pe_project_root_for <dir> → the console root that would claim <dir>: the
# nearest ancestor that looks like a project (`docs/plans`, `plans`, or a
# `.phase-console.json` — the same test `instances.mjs` `looksLikeProject`
# makes). Prints NOTHING when no ancestor does: a directory no console could
# own has no presence to record. Used where the question is about a DIRECTORY
# rather than about the repository a script is standing in.
pe_project_root_for() {
  local dir="$1" probe
  case "$dir" in /*) : ;; *) dir="$(pwd)/$dir" ;; esac
  case "$dir" in */) [ "$dir" = "/" ] || dir="${dir%/}" ;; esac
  probe="$dir"
  while :; do
    if [ -d "$probe/docs/plans" ] || [ -d "$probe/plans" ] || [ -f "$probe/.phase-console.json" ]; then
      printf '%s' "$probe"; return 0
    fi
    [ "$probe" != "/" ] && [ -n "$probe" ] || break
    probe="$(dirname "$probe")"
  done
  return 1
}

# pe_sha256_prefix <text> → the first 8 hex chars of sha256(text)
pe_sha256_prefix() {
  local hex=""
  if command -v shasum >/dev/null 2>&1; then
    hex="$(printf '%s' "$1" | shasum -a 256 2>/dev/null | cut -c1-8)"
  elif command -v sha256sum >/dev/null 2>&1; then
    hex="$(printf '%s' "$1" | sha256sum 2>/dev/null | cut -c1-8)"
  elif command -v openssl >/dev/null 2>&1; then
    hex="$(printf '%s' "$1" | openssl dgst -sha256 2>/dev/null | sed 's/^.*= *//' | cut -c1-8)"
  fi
  printf '%s' "$hex"
}

# pe_instance_id <root> → "<sha8>-<basename>" (basename `root` for "/")
pe_instance_id() {
  local root="$1" base hex
  base="$(basename "$root")"
  [ -n "$base" ] && [ "$base" != "/" ] || base="root"
  hex="$(pe_sha256_prefix "$root")"
  printf '%s-%s' "$hex" "$base"
}

# pe_runs_dir <root> <slug> → where the console keeps this plan's runs
pe_runs_dir() {
  printf '%s/runs/%s/%s' "$(pe_state_home)" "$(pe_instance_id "$1")" "$2"
}

# pe_instance_state_dir <root> → this root's per-instance state directory.
# Without the registry (JSON, which bash 3.2 should not parse) the default
# instance is told apart by what exists: a console that was ever started for a
# non-default root created <state>/instances/<id>; the default instance keeps
# the flat state home.
pe_instance_state_dir() {
  local home id
  home="$(pe_state_home)"
  id="$(pe_instance_id "$1")"
  if [ -d "$home/instances/$id" ]; then printf '%s/instances/%s' "$home" "$id"; else printf '%s' "$home"; fi
}
