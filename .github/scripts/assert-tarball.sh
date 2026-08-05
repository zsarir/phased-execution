#!/usr/bin/env bash
# Assert the npm tarball's contents: everything the console needs at runtime is
# present, and nothing that must never ship is inside. The `files` allowlist in
# package.json is the intent; THIS is the proof — npm-packlist behavior has
# shifted across npm versions, so never trust the allowlist alone.
#
#   assert-tarball.sh <path-to-tgz>
set -uo pipefail

tgz="${1:?assert-tarball.sh needs the tarball path}"
[ -f "$tgz" ] || { echo "no such tarball: $tgz" >&2; exit 2; }

list="$(mktemp)"
trap 'rm -f "$list"' EXIT
tar -tzf "$tgz" > "$list"

fail=0

# Runtime file set — see the packaging plan. server/index.js is the
# pre-stripped entry for installs that land under node_modules.
for p in \
  "viewer/client/dist/index.html" \
  "viewer/client/dist/sw.js" \
  "viewer/client/dist/.build-rev" \
  "viewer/server/index.ts" \
  "viewer/server/index.js" \
  "viewer/server/platform.ts" \
  "viewer/server/platform.js" \
  "viewer/server/fallback-sw.js" \
  "viewer/shared/scope.js" \
  "viewer/shared/instances.mjs" \
  "viewer/scripts/check-stamp.mjs" \
  "viewer/run" \
  "viewer/package.json" \
  "viewer/deploy/agent.sh" \
  "viewer/deploy/desktop-launcher.command" \
  "scripts/phase-graph.sh" \
  "scripts/validate.sh" \
  "scripts/next-phase-prompt.sh" \
  "scripts/phase-lock.sh" \
  "scripts/new-plan.sh" \
  "scripts/new-handoff.sh" \
  "scripts/qa-record.sh" \
  "scripts/close-plan.sh" \
  "scripts/handoff-status.sh" \
  "scripts/scope.sh" \
  "scripts/sizing.env" \
  "templates/plan.md" \
  "templates/handoff.md" \
  "templates/INDEX.md" \
  "references/qa-method.md" \
  "assets/report-template.md" \
  "bin/phase-console" \
  "bin/phase-console.mjs" \
  "start" \
  "SKILL.md" \
  "LICENSE" \
  "README.md" \
  "package.json"; do
  grep -q "^package/$p\$" "$list" || { echo "MISSING from tarball: $p" >&2; fail=1; }
done

# Never-ship set. CLAUDE.md guards local repo guidance; the last entries guard
# the other shared/ modules (client-only) from creeping in.
for a in \
  "viewer/test/" \
  "viewer/client/src/" \
  "viewer/client/public/" \
  "viewer/vite.config.ts" \
  "viewer/tsconfig.json" \
  "viewer/scripts/stamp-build.mjs" \
  "viewer/scripts/check-dist.mjs" \
  "docs/" \
  "tests/" \
  "evals/" \
  ".github/" \
  ".claude-plugin/" \
  "package-lock.json" \
  "CLAUDE.md" \
  "viewer/shared/routes" \
  "viewer/shared/setup-prompts" \
  "viewer/shared/console-model" \
  "viewer/shared/phase-model" \
  "viewer/shared/sw-push"; do
  if grep -q "package/$a" "$list"; then
    echo "MUST NOT ship, but is in tarball: $a" >&2
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "tarball assertions PASS ($(wc -l < "$list" | tr -d ' ') files)"
fi
exit "$fail"
