# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the npm/Homebrew release
tags (`vX.Y.Z`), published by CI from the tag. The Claude Code **plugin** channel is deliberately
versionless — it tracks every commit to `main` — and `SKILL.md`'s own `metadata.version` tracks
skill content, independent of these package releases.

## [1.0.1] - 2026-08-05

The same console as 1.0.0, released through the pipeline: this is the first version published by
`release.yml` from a `vX.Y.Z` tag — with npm **provenance**, the GitHub Packages mirror
(`@zsarir/phase-console`), and a GitHub Release carrying the tarball. 1.0.0 was the one-time manual
bootstrap publish that npm's trusted publishing requires before a publisher can be attached.

## [1.0.0] - 2026-08-05

First release — the console becomes installable as a package (published manually, once, to
bootstrap trusted publishing).

### Added

- **npm channel**: `npm install -g phase-console` (or one-off `npx phase-console`) — the whole
  skill tree with the client **prebuilt**, so the per-machine `npm ci && npm run build` step does
  not exist on this route.
- **Homebrew channel**: `brew install zsarir/homebrew-tap/phase-console`.
- `bin/phase-console.mjs` — symlink-safe Node entrypoint for packaged installs: resolves the
  package root through npm's global-bin symlink chain and Homebrew's `opt` path, maps a bare first
  argument to `--root`, hands the `--*-agent` verbs to `deploy/agent.sh`, and forwards exit codes
  and signals faithfully.
- Pack-time type strip: the tarball carries pre-stripped `server/*.js` beside the `.ts` sources,
  because Node refuses to run TypeScript from under `node_modules` — exactly where npm installs
  live. Entrypoints pick the `.js` only there; everywhere else the `.ts` stays the truth.
- CI from zero: test + scrub + tarball-content gates on every push and PR; a tag-triggered release
  workflow that packs, asserts and scrubs the artifact, publishes to npm with **OIDC provenance**
  (no tokens anywhere), creates the GitHub release, and can open a version-bump PR on the tap.

### Changed

- Honest Node floor everywhere: **>=22.18 or >=23.6** (native type stripping is unflagged only from
  those lines; 22.6 was never enough without a flag).
- `node-pty` and `ws` are `optionalDependencies` — the console's designed degradation carries the
  board, writes and autopilot even when the native module is absent. The client's build libraries
  moved to `devDependencies`; they are baked into `client/dist`.
- The desktop launcher and the setup prompts now also find npm (`npm root -g`) and Homebrew
  (`brew --prefix phase-console`) installs, and honor `PHASE_CONSOLE_HOME` as an override.

### Fixed

- `check-stamp` no longer compares a packaged install's build against whatever git repository
  happens to contain the install directory (Homebrew's Cellar sits inside Homebrew's own repo,
  which made every start cry STALE).
- `--install-agent` from a packaged install uses the shipped client build instead of dying on a
  build it has no sources or lockfile for.
