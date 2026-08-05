# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the npm/Homebrew release
tags (`vX.Y.Z`), published by CI from the tag. The Claude Code **plugin** channel is deliberately
versionless — it tracks every commit to `main` — and `SKILL.md`'s own `metadata.version` tracks
skill content, independent of these package releases.

## [Unreleased]

A plan can be closed — an off switch for work that will never be finished.

### Added

- **`scripts/close-plan.sh`** — close a plan with a dated reason
  (`close-plan.sh <slug> --reason "…"`, optionally `--status superseded|complete`), or `--reopen` to
  undo. Writes only the plan's frontmatter (`status`, `closed`, `closed_reason`) and releases that
  plan's own phase locks. Never runs git.
- **`phase-graph.sh --plan-status` and `--closed`** — the closure predicate, defined once so every
  other script asks rather than re-parsing frontmatter.
- `status: superseded` joins the documented vocabulary alongside `active`, `complete`, `abandoned`.

### Changed

- **A terminal status (`complete`, `abandoned`, `superseded`) now means the plan is closed**, and a
  closed plan stops reporting: no ready phases, no QA-failure or stuck-handoff alarm, no batching,
  no boot prompts, no "mark the plan complete" nudge. Its board still renders in full — closing
  quiets a plan, it never hides one — and structural problems are still named, demoted to notes.
  Previously `status:` was documented but honoured nowhere, so a finished or abandoned plan kept
  raising errors with no way to stop it.
- `validate.sh` skips a closed plan instead of flunking it forever; `next-phase-prompt.sh` prints a
  closure notice instead of boot prompts; `new-handoff.sh` refuses to scaffold into a closed plan
  (`--force` overrides).
- **`phase-lock.sh conflicts` ignores locks belonging to a closed plan.** The scan crosses every
  plan, so an abandoned plan's leftover lock used to block sessions on unrelated plans until its
  lease happened to lapse.
- The all-phases-done banner now points at `close-plan.sh` rather than asking for a hand edit.

## [1.1.0] - 2026-08-05

Linux — and Windows through WSL2 — become first-class: same features, same buttons, honest
fallbacks where a platform has no equivalent.

### Added

- **systemd support.** `--install-agent` on Linux writes a `systemd --user` service
  (`Restart=always`, the same 150s stop grace, logs in the same files) instead of assuming
  `launchctl`; `--agent-status`, `--agent-restart`, `--agent-log`, `--uninstall-agent` and
  `--agent-update` all speak systemctl there. On WSL without systemd, install explains the one-time
  `[boot] systemd=true` enablement instead of failing cryptically.
- The server reads its own unit file (the unit stamps its name as `PHASE_CONSOLE_UNIT`) the way it
  reads a launchd plist: the Restart button is offered on read evidence (`Restart=` covering a
  clean exit), and **Shut down** ends a systemd-supervised console with `systemctl --user stop` —
  stopped means stopped.
- WSL-aware browser opening: `wslview` → `xdg-open` → `explorer.exe`, and a printed URL when no
  opener exists. "Open in editor" prefers the Windows side on WSL too.
- **Lifecycle words on the bin**: `phase-console start | stop | restart | status | logs [-f]`
  (and `--agent-start` / `--agent-stop` on `./start`). `stop` stops the supervised console without
  uninstalling it; `start` brings it back — or runs in the foreground when no agent is installed.
- **`phase-console install-skill`**: copies the skill's files from a package install into
  `~/.claude/skills/phased-execution` (or `$CLAUDE_CONFIG_DIR/skills`), so npm and Homebrew
  installs can register the *skill* with Claude Code too — no plugin or clone required. Stamped,
  so it refreshes or removes only its own copies and refuses to touch a git clone;
  `uninstall-skill` undoes it.
- CI proves it: the console suite and the bash-engine suite now each run on ubuntu as release
  gates beside the macOS runs.
- Releases open the Homebrew bump PR automatically (`TAP_GITHUB_TOKEN` armed).

### Changed

- README rebuilt around the published packages: an install table (npm / Homebrew / npx / plugin /
  clone), CI + platform badges, and a quick start. `docs/install.md` gains **Linux, and Windows
  through WSL2** — systemd, lingering, localhost forwarding, and the node-pty build-tools note
  (no Linux prebuilds ship; it compiles at install, and the console degrades honestly without it).
- `.secrets/` is now entirely gitignored — the token how-to lives in `docs/releasing.md` instead
  of a tracked file inside the drop-point.

### Fixed

- Docs no longer describe the background agent as launchd-only, and name the npm package
  unambiguously: it is `phase-console`, **unscoped** — `@zsarir/phase-console` is the
  auth-required GitHub Packages mirror, which the default registry answers 404 for.

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
