#!/usr/bin/env bash
# Public-repo leak scrub. Two modes:
#
#   scrub.sh                 repo mode — tracked files ∪ staged files
#   scrub.sh --dir <path>    artifact mode — every file under <path> (strict)
#
# Repo mode scans what is public or about to become public: everything tracked
# plus everything staged for the next commit. Untracked, unstaged files are a
# different workstream's business — they are LISTED as a notice, never failed
# on, so a concurrent effort's local files cannot block an unrelated commit.
# Artifact mode is for an unpacked npm tarball: everything in it ships, so
# everything is checked, strictly.
#
# Checks:
#   1. identity strings that must never appear in this repository
#   2. email addresses — only documentation placeholders are allowed
#      (@example.com/.org, @x.com, plus exact entries in scrub-allow.txt)
#   3. a private tool's name — allowed in exactly one neutrality test in repo
#      mode, nowhere at all in an artifact
#
# Target runtime is macOS system bash 3.2 (same rule as scripts/), and it also
# runs on Linux CI. Exits non-zero on any failure.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOW_FILE="$HERE/scrub-allow.txt"

# Every needle is assembled from parts, so this file never contains the very
# strings it hunts — a committed scrub that spelled them out would itself be
# the leak (and would flag itself on every run).
IDENTITY_RE="front-ad""min|tra""de-|themarket""robo|/Use""rs/"
EMAIL_RE='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
PLACEHOLDER_RE='@(example\.(com|org)|x\.com)$'
TOOL_WORD='gra'
TOOL_WORD="${TOOL_WORD}phify"
# Deliberate repo-mode appearances: the neutrality test that forbids the name
# in generated text, and .gitignore's entries for the tool's local output.
# Neither ships — artifact mode allows nothing.
TOOL_ALLOWED_REPO_FILES='viewer/test/git-strategy.test.ts
.gitignore'

mode="repo"
dir=""
if [ "${1:-}" = "--dir" ]; then
  mode="dir"
  dir="${2:?scrub.sh --dir needs a path}"
  [ -d "$dir" ] || { echo "scrub: no such directory: $dir" >&2; exit 2; }
fi

# ---- the file set -----------------------------------------------------------
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT

if [ "$mode" = "dir" ]; then
  ( cd "$dir" && find . -type f | sed 's|^\./||' ) | sort -u > "$LIST"
  cd "$dir" || exit 2
else
  root="$(git rev-parse --show-toplevel)" || { echo "scrub: not a git repository" >&2; exit 2; }
  cd "$root" || exit 2
  { git ls-files; git diff --cached --name-only --diff-filter=ACMR; } | sort -u > "$LIST"
  untracked="$(git ls-files --others --exclude-standard)"
  if [ -n "$untracked" ]; then
    echo "scrub: notice — untracked files exist and are NOT scanned (stage them to include them):"
    echo "$untracked" | sed 's/^/    /'
  fi
fi

fail=0

# ---- 1. identity strings ----------------------------------------------------
hits="$(tr '\n' '\0' < "$LIST" | xargs -0 grep -IliE "$IDENTITY_RE" 2>/dev/null || true)"
if [ -n "$hits" ]; then
  echo "scrub FAIL: identity strings found in:" >&2
  echo "$hits" | sed 's/^/    /' >&2
  fail=1
fi

# ---- 2. emails --------------------------------------------------------------
# package-lock.json carries upstream maintainers' addresses — not ours to scrub.
emails="$(grep -v 'package-lock\.json$' "$LIST" | tr '\n' '\0' \
  | xargs -0 grep -IhoE "$EMAIL_RE" 2>/dev/null | sort -u || true)"
if [ -n "$emails" ]; then
  allow="$(mktemp)"
  grep -vE '^[[:space:]]*(#|$)' "$ALLOW_FILE" 2>/dev/null > "$allow" || true
  bad="$(echo "$emails" | grep -viE "$PLACEHOLDER_RE" | grep -vxFf "$allow" || true)"
  # grep -f with an empty pattern file matches nothing under -x -F on BSD and
  # GNU alike, but guard the degenerate case explicitly all the same.
  if [ ! -s "$allow" ]; then
    bad="$(echo "$emails" | grep -viE "$PLACEHOLDER_RE" || true)"
  fi
  rm -f "$allow"
  if [ -n "$bad" ]; then
    echo "scrub FAIL: non-placeholder email addresses found:" >&2
    echo "$bad" | sed 's/^/    /' >&2
    fail=1
  fi
fi

# ---- 3. the tool name -------------------------------------------------------
tool_hits="$(tr '\n' '\0' < "$LIST" | xargs -0 grep -Iil "$TOOL_WORD" 2>/dev/null || true)"
if [ "$mode" = "repo" ] && [ -n "$tool_hits" ]; then
  tool_hits="$(echo "$tool_hits" | grep -vxF "$TOOL_ALLOWED_REPO_FILES" || true)"
fi
if [ -n "$tool_hits" ]; then
  echo "scrub FAIL: '$TOOL_WORD' found in:" >&2
  echo "$tool_hits" | sed 's/^/    /' >&2
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "scrub PASS ($mode mode, $(wc -l < "$LIST" | tr -d ' ') files)"
fi
exit "$fail"
