# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the npm/Homebrew release
tags (`vX.Y.Z`), published by CI from the tag. The Claude Code **plugin** channel is deliberately
versionless — it tracks every commit to `main` — and `SKILL.md`'s own `metadata.version` tracks
skill content, independent of these package releases.

## [1.4.0] - 2026-08-05

A claim on a phase now means something. Every phase table shows who holds a phase and for how much
longer, all four of them agree about what a phase *is*, and the console refuses to start a session
on work somebody else is already doing — instead of accepting the launch and discovering the
collision three subprocesses later.

### Added

- **A Lock column on every phase table.** The Autopilot table carried each phase's claim in its data
  and read it nowhere: a phase could be held by another session and the table would still offer to
  start it. It, the Departures board, the Phases list and the Overview graph now all show **held by
  … · 18m** or **stale claim**, with the owner in the chip rather than behind a hover — there is no
  hover on a phone.
- **Dependencies on every phase table.** What a phase waits on and what waits on it were on the wire
  for every row and rendered richly in one place. Both directions now appear everywhere, always —
  the Departures board used to show them only while a phase was *waiting*, so the plan's shape was
  invisible on every row that was moving.
- **An expandable sheet on every Autopilot row** carrying every remaining field: goal, gates and
  their live check, read-first, files, steps, exit criteria, verification, handoff-must-record,
  model, effort, weight, parallel-safe, downstream count, handoff status and outstanding work, the
  QA report, and the full claim (owner · host · claimed · lease · scope).
- **A claim ring on the route map**, and stations whose tooltip names what they wait on and who
  holds them.
- **`Release the claim`** — a confirmed, audited force-release for a claim whose lease is still
  running. Previously a live claim could only be cleared from a terminal, which was fine while a
  claim was decoration and a dead end once one started blocking runs. The dialog names the holder,
  the machine and the time left before it will do it.
- **A claim vocabulary** in the Guide's Reference, single-sourced with the chips' own tooltips.

### Changed

- **A live claim refuses a launch, in the server as well as the page.** `POST /api/run/<slug>/start`
  on a claimed phase used to answer **200**, mint a run, and only degrade to `parked` deep inside the
  runner — the console reported a run that never ran. Starting a named phase, retrying one,
  recovering one and reviewing one all now answer **409** with the holder, the host and the lease.
  A whole-plan run is deliberately *not* refused: it parks the claimed phase and gets on with the
  rest, because one claim should not stop a plan.
- **Buttons a claim blocks are disabled, not hidden** — they keep their place and say who holds the
  phase. A button that vanishes teaches nothing about why nothing can be started.
- **Repos renders as scope chips on the Departures board**, which was the one table of three still
  printing the raw graph cell.

### Fixed

- **A lapsed claim no longer parks a phase.** `phase-lock.sh status` prints `held by X` for an
  expired claim too and appends `(EXPIRED — free to take over)`; the runner read only the first half.
  A session that died without releasing therefore blocked its phase for the whole lease — and then
  kept blocking it, because nothing renews a dead claim. A lease running out is precisely the event
  that means *go*.
- **The per-phase claim payload no longer drops `host`, `claimedAt` and `scope`.** Two call sites
  narrowed the parsed lock by hand and had already drifted apart, so the same claim described itself
  differently depending on which list you found it in. One helper does it now.

## [1.3.0] - 2026-08-05

One install, one console per project. `cd` into a repository and `phase-console start` — it gets its
own port, its own state and its own supervisor, while the consoles for your other projects keep
running. A single-project machine gains nothing new and loses nothing: the first console keeps port
4123, the plain unit name and every path it already had.

### Added

- **Per-project consoles.** A console belongs to a repository root, and its identity is derived from
  that path (`sha256(realpath(root))[:8]-basename(root)`), so the same project is always the same
  console across restarts and reboots with nothing written down. `viewer/shared/instances.mjs` is
  the single definition of identity, the registry and ports — imported rather than re-derived, so
  the bash, Node and server readings cannot drift apart.
- **`phase-console list`** — every console with its name, root, port, status and unit, status from a
  live 2s probe rather than from what the registry hoped.
- **`phase-console open [<sel>]`** — open one in the browser; refuses when it is stopped and names
  the command that starts it. `PHASE_CONSOLE_NO_OPEN=1` makes it print the URL instead.
- **Instance selectors on every verb.** `start`, `stop`, `restart`, `status`, `logs` and `open` each
  take `[<instance>]`, `--instance <sel>` or `--root <dir>`; with none, they mean the console for
  the directory you are standing in. A selector matches an id, a name, or a unique folder name.
  `status` with no selector reports **all** consoles.
- **`.phase-console.json`** — commit `{"name": …, "port": …}` at a repository root to name that
  project's console for everyone who clones it, or to pin its port.
- **A registry** at `~/.config/phase-console/instances.json`: name, root, port, unit, pid per
  console. Ports are reserved by *registration* rather than by being bound, so a stopped console
  still owns its port and a restart lands where it was.

### Changed

- **Ports.** The first console on a machine keeps 4123. Every other project derives a stable port in
  **4124–4223** from its path; if something already holds it the server probes upward and records
  what it actually bound. Precedence: `--port` → `PHASE_CONSOLE_PORT` → `.phase-console.json` → the
  port it last actually bound → derived. Naming a port explicitly turns probing off, because naming
  one means wanting it.
- **Starting a console on a port that belongs to another project is refused by name**, naming the
  project that owns it, instead of failing with an address-in-use.
- **Per-console state.** Logs, notifications, push keys and subscriptions, approvals and settings
  live under `instances/<id>/`. The default instance keeps the top-level paths byte-for-byte, so
  nothing moves on upgrade; run journals were keyed by repository already and move for nobody.
- **Per-console supervisors.** Generated units are `com.phase-console.<id>` /
  `phase-console-<id>.service`. The default instance keeps the bare pre-1.3.0 names, so upgrading
  never renames the agent you already have. `agent.sh install` gained `--instance`, and its `--port`
  now defaults to the *instance's* port rather than to 4123; `uninstall` clears only the registry's
  `unit` field, because the instance still exists — it just has no supervisor.
- **The plans page reports what it is hiding.** With closed plans and documents hidden by sticky
  preferences, a large library could render a single row and explain itself in a grey line. The
  toggles now carry what they would bring back (`Show closed +71`) in the accessible name as well as
  the pixels, a dismissible banner appears when the shape filters hide most of the source, and the
  subtitle says "1 of 87 rows" — a true sentence about the list rather than a false one about the
  source. The defaults are unchanged.
- **Closed plans are marked where they were not.** The plan header carries a `CLOSED · <status>`
  badge rather than a chip, and the plans *table* gained a marker it never had — every other signal
  it shows is one closure suppresses, so a closed plan rendered as a live plan with nothing to do.
- CI isolates `runner-parallel.test.ts` with one retry. Two of its tests measure scheduling against
  real sleeps, and one failed the v1.2.0 release on macOS while the CI workflow passed the same job
  on the same commit concurrently — both workflows fire on a tagged push and race for runners.

### Fixed

- **Two consoles booting together could lose one another's registry entries.** `withRegistry` gave
  up on a contended lock immediately and wrote anyway; the write is atomic but read-modify-write is
  not, and the lost field that matters is `pid` — the one thing `stop` needs for an unsupervised
  console. It now waits up to 2s for the lock before falling back.
- **The default-instance election now happens inside the registry lock.** A caller that read "is
  there a default yet" and then registered could race another doing the same, and the loser would
  silently inherit the legacy port *and the legacy state directory* — another console's log and push
  subscriptions.
- **A `name` in a committed `.phase-console.json` could inject a line into what `agent.sh` reads.**
  The file arrives with a clone and its name reaches `key=value` lines bash parses a unit path out
  of. Control characters are now stripped at the source, replaced with spaces so nothing is silently
  joined.
- `config.ts` imports `STATE_DIR`, `instanceStateDir`, `configDir` and the legacy unit name from the
  shared module instead of keeping second copies. `configDir` falls through `env` → `process.env` →
  `homedir()`, so a caller passing a *partial* env can no longer escape a sandbox and read the real
  registry.

## [1.2.0] - 2026-08-05

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
- **The console honours closure too.** A closed plan contributes no health issues (progress problems
  are dropped; structural damage stays, demoted to `info`), no ready phases, no remaining weight or
  sessions, and never appears as stalled — and `POST /api/write` gains `close-plan` / `reopen-plan`,
  so a plan can be closed from the console with the same validated argv an operator would type.
  Search still finds closed plans, by design.
- **A closed plan no longer sends notifications about its own progress** — phases landing, work
  becoming ready, a plan finishing, files changing. Notifications about a live *process* —
  permission needed, a phase awaiting a person, a halted or parked run, a session ending, console
  health — still fire, because a stale `status:` line must not be able to strand a running session
  in silence.
- Repairing a closed plan is refused with a 409 that says to reopen it first, rather than reporting
  that there is nothing to repair.
- **A closed plan now reads as closed everywhere in the console, and can be closed or reopened from
  it.** The plan page leads with a banner saying which terminal word applies, when, and why; the
  status chip carries a padlock; and the plan's own action menu gains **Close plan** (a status and a
  required one-line reason, previewed as the exact `close-plan.sh` invocation) and **Reopen** (a
  confirm, because it silently puts the plan back on every board). Closed plans no longer appear on
  the departures board, in the "Ready now" nav badge or tile, in the dashboard's "start this next"
  recommendation, among the in-flight plan strips, or as ready chips and boot-prompt cards on the
  plan page; their stuck / QA / stale-lock / idle warnings are silenced, their structural damage
  stays visible but demoted, and a lapsed lock on one now reads as debris rather than a chore, since
  `phase-lock.sh` already ignores it. Search still lists them, now with a `closed` badge.
- **The plan list hides closed plans by default** — one toggle away, and a deliberate change of
  behaviour: the toggle it replaces ("Hide finished") defaulted to *showing* every finished plan, so
  a library of sixty-odd complete plans opened on all of them. A closed row that is on screen says
  what happened to it ("abandoned — 3 of 4 phases never ran") instead of offering phases to start.

  ⚠️ A plan's **per-plan** `ready` array stays populated when it is closed, on purpose — the engine
  reports what never got done so the plan's own board can say so, and engine-parity depends on it.
  Only the portfolio aggregates are gated server-side, so anything that turns `ready` into a call to
  action must gate it itself. `viewer/client/src/lib/closure.ts` is the one place the client decides.

- **Closure is documented as a plan's lifecycle, not a flag.** [The artifacts](docs/artifacts.md)
  gains the whole story — why "does anyone still care?" is the one piece of plan state that is stored
  rather than computed, and a table of exactly what closing stops and what it keeps. The command
  reference, the console's write verbs and the setup prompts list the new verb; the in-app Guide's
  "Status words" grows a **fourth** vocabulary (plan status) beside run, phase and board; and the
  Persian mirrors move with the English.
- **`docs/qa-gating.md` answers the question a permanent `fail` raises.** A recorded failure still
  outlives the QA switch, and closing the plan is now the documented other exit — it retires the
  report without a re-QA, because a closed plan claims nothing about progress. Re-QA clears a
  failure; closure stops you caring about one. Neither pretends the other happened.

### Fixed

- **The test suite no longer runs against the operator's own console state.** Spawned consoles
  inherited `XDG_STATE_HOME`, so they loaded the real `push/subscriptions.json` and delivered real
  push notifications to real devices — the shutdown test announced "Phase Console is shutting down ·
  asked for by a test" to a subscribed browser on every run — and the suite left thousands of
  fixture run journals in the real state directory. Every test now redirects its state and config
  directories, spawned consoles get a sandbox root instead of whatever library the config
  remembered, and `test/state-isolation.test.ts` fails if a new test file forgets either.

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
