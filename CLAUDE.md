# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the **source of the `phased-execution` Agent Skill itself** — not a project that uses it.
Work here is skill authoring: the procedure Claude follows (`SKILL.md`), the bash engine that computes
phase state (`scripts/`), and Phase Console, the local web app that reads it (`viewer/`).

It installs two ways from one tree: as a plain skill (clone into `~/.claude/skills/`) or as a plugin
(`.claude-plugin/marketplace.json`, `strict: false`). **There is deliberately no `plugin.json`** — the
marketplace entry carries the metadata so the folder stays a valid bare skill. Don't add one.

**Skill vs work-state.** Plans, handoffs, QA reports, locks and `test-status.md` are *work-state* and
live in the consuming project's repo under `docs/plans` / `docs/handoffs`. Never write work-state into
this tree; `tests/fixtures/plans/` is the only place plan markdown belongs here.

## Commands

```bash
tests/run-tests.sh            # the bash engine: shellcheck (if present) + bats unit + integration
bats tests/unit/parse.bats    # a single suite
bats -f "gated" tests/unit    # a single test by name filter
```

`bats-core` is required (`brew install bats-core`). Tests are hermetic: each creates its own
`DOCS_ROOT` in `$BATS_TEST_TMPDIR` and copies a fixture plan in.

```bash
cd viewer
npm ci                        # once
npm test                      # server + shared contracts (node --test, needs no build)
PHASE_CONSOLE_TEST_ROOT=~/code/your-repo npm test   # + integration and engine-parity tests
node --test test/runner.test.ts                     # a single server test file
npm run test:client           # client suite (Vitest + jsdom)
npm run typecheck:client      # two programs: the app (DOM libs) and the service worker (WebWorker libs)
npm run dev                   # Vite on :5173, proxying the live console on :4123
npm run build                 # emit client/dist and stamp .build-rev
npm run check:dist            # the build gate — run it after every build
```

```bash
./start [<repo-with-docs-plans>] [--allow-writes] [--port N] [--no-open]   # run the console
./start --agent-status | --agent-log -f | --agent-restart                  # the launchd agent
phase-console list | open | start | stop | restart | status | logs | remove [<sel>] # one console per project
```

**One install, one console per project.** Identity, the registry and ports live in
`viewer/shared/instances.mjs` — the single definition everything else imports rather than re-deriving
(`config.ts`, `bin/phase-console.mjs`, and `deploy/agent.sh`, which shells its `shell` op for
`key=value` lines because it may have neither `jq` nor python). An instance id is
`sha256(realpath(root))[:8]-basename(root)`; the default instance keeps port 4123, the bare
`com.phase-console` unit name and the top-level state paths, and every other project derives a port
in 4124–4223. Identity **must** resolve at module load — log, notification, push and approval paths
are module-level consts, so a late resolution writes global state while reporting a private id.

The Node suite must keep passing **without** a client build — a fresh clone verifies the server before
`dist` exists (`test/static.test.ts` holds the not-built answers, including the `/sw.js` fallback).

## Architecture

Three layers, in strict dependency order. Each lower layer is authoritative for the one above.

**1. `scripts/` — the engine (bash, deterministic, output-only).**
`phase-graph.sh` is the single source of truth for **done / ready / waiting**, session batching, boot
prompts, QA regime and lint. It parses the plan's `## Phase graph` table plus live handoff frontmatter
and recomputes state every time — there is no stored "current phase" cursor anywhere in the system, by
design, so out-of-order and resumed work stay correct. The other scripts (`new-plan.sh`,
`new-handoff.sh`, `next-phase-prompt.sh`, `handoff-status.sh`, `validate.sh`, `phase-lock.sh`,
`qa-record.sh`) all call it rather than reimplementing readiness.

**2. `SKILL.md` — the procedure.** Frontmatter (`name` + `description`) is the only part always in
context; the body loads only when the skill fires. Three modes: `plan`, `phase-start`, `phase-finish`.
Deep material is deferred to `references/` (plan format, handoff format, conventions, sizing, QA
method) so the body stays small — keep new detail there, not inline.

**3. `viewer/` — Phase Console.** Node 22.18+/23.6+ server (runs TypeScript directly, zero required
runtime deps — `node-pty`/`ws` are optional with honest degradation) plus a Vite/React client that
is *built output*. It **shells out to the layer-1 scripts**
for every status claim and never recomputes them; its own JS parsing covers only what the scripts
don't expose (prose sections, handoff bodies) plus analysis they don't provide (critical path,
velocity). `server/service.ts` is the model, `engine.ts` the script wrapper, `store.ts` the files,
`runner/` the autopilot, `accounts/` the Claude identities it may spend, `launcher.ts` the desktop
artifact, `api/routes.ts` the surface. `shared/` is dependency-free ESM imported by both the Node
tests and the client.

### Accounts and the usage window

`server/accounts/` is per-instance, like the push keys and unlike `runs/` — two consoles on one
machine are usually two projects with two ideas about whose quota they may burn. `store.ts` is the
registry of three kinds (`default`, the machine's own `claude` login, synthesized on every read and
never stored or deleted; `profile`, a console-managed `CLAUDE_CONFIG_DIR` the operator signs into;
`token`, a pasted `claude setup-token`), `credentials.ts` is the only file that touches secrets —
keychain or a 0600 file for ours, **read-only** for the CLI's own, because a second writer is how two
processes corrupt one login — `usage.ts` polls the same endpoint the CLI's own `/usage` asks (gently:
single-flight, adaptive cadence, harder backoff on 429), `transcripts.ts` copies a
session's `.jsonl` into the target account's config dir so `--resume` finds the conversation, and
`index.ts` is the facade whose every answer is already redacted, so the boundary is there and not in
a route. State lives under `INSTANCE_STATE_DIR/accounts`; `accounts.json` never holds a secret.

Two rules the code is built around. **Bucket names are data, not schema** (`five_hour`, `seven_day`,
`seven_day_opus`, whatever tier ships next) — anything with a `utilization` and a `resets_at` is a
meter, rendered by name; a per-model wall files under its own bucket so `auto` skips an account only
for that model. And **the poller is telemetry, never the detector** — the runner's own limit
classifier works with the meters unavailable, so a 429 or a vanished endpoint degrades to stale
numbers with their age attached, never an error page.

At a wall the run's `onLimit` policy decides: `wait` sleeps on the window (restart-safe — the run
reconciles to `paused` with its clock intact and the service re-arms the resume at boot), `switch`
checkpoints the live session and re-attempts at once under the account with headroom, `pause` means
what it says. The scheduler's usage throttle is keyed **per account**, so one spent login never
stalls a queue another account would pay for; `throttledUntil` stays as the soonest expiry for
readers that predate that.

### Getting the console started — the launcher and the start command

`server/launcher.ts` behind `/api/launcher` writes the desktop artifact itself, per platform and
honestly: macOS gets the shipped `deploy/desktop-launcher.command` with its knobs patched, Linux an
XDG `.desktop` whose `Exec` paths are baked absolute (Exec lines expand no variables), Windows the
WSL story rather than a shortcut that would break. Everything filesystem-shaped is a parameter, so
tests never touch a real Desktop. **Bump `LAUNCHER_REV` whenever the template's argv changes** — that
is what tells an installed copy it is stale instead of letting it start a console whose Settings
disagrees with it. The Settings start-command card composes the same line from the console's own
facts and renders every path as `$HOME/…`: the line must paste on any account and a screenshot must
carry no username, and a scrubbed test keeps the shipped template personal-path-free. `viewer/run`
looks past the PATH's `node` when it is below the floor (Homebrew, `/usr/local`, volta, newest nvm)
rather than refusing.

### Invariants that tests enforce — don't break them casually

- **Engine parity.** `viewer/test/engine-parity.test.ts` re-derives every plan's board from the JS
  parser and asserts it matches `phase-graph.sh`. Run it after touching *either* parser.
- **F5 — one sizing source.** `scripts/sizing.env` holds every size weight and per-model budget.
  `phase-graph.sh` sources it, `references/sizing.md` documents those exact numbers, and
  `viewer/server/analysis/graph.ts` reads the same file. Change a number only there.
- **F1/F2/F3 — structural lint** (malformed phase cell, undefined dependency, cycle) lives in
  `phase-graph.sh --lint`; `validate.sh` delegates to it and adds handoff body/consistency checks.
  **F14** rides the same arm as a WARNING (stderr, exit untouched): an open, not-done phase whose
  §Verification holds nothing runnable — the thing the autopilot would otherwise park on at boarding.
- **bash 3.2.** The scripts' target runtime is macOS system bash. `tests/helpers/test_helper.bash`
  forces `/bin/bash` for every script under test — no associative arrays, no `${var^^}`, no `mapfile`.
- **Never implicitly build the client.** `client/dist` is gitignored; the console warns when the build
  is stale and serves an explanatory page when it's missing, but nothing builds on its own. The
  launchd boot path especially never builds, so a crash loop can't burn its throttle interval.
- **`sw.js` stays at the root and stays push-capable.** Live push subscriptions are bound to
  `('/sw.js', scope '/')`; moving or renaming it unsubscribes every device silently. `check-dist.mjs`
  guards this and several other one-time regressions — read its header before weakening an assertion.
- **The console binds to `127.0.0.1`, always.** `--remote` adds an allowlisted proxy hostname and
  identity check; it deliberately does not widen `--host`. The `Tailscale-User-Login` header is only
  trustworthy because nothing but the proxy can reach the port.
- **Permission `deny` is identical across all three run profiles.** Profiles move only the ask list.
  The PreToolUse hook fails open and carries workflow, never safety.
- **A shipped default is struck by name — `deny` included, since 2026-08-06.** Removing a default
  records it under `removed.<list>` in the policy file rather than copying the list out and editing
  it — a copied list would freeze the defaults at whatever version the first edit saw, and an
  upgrade's new rules must still apply. Restoring is deleting that name. The deny half is a
  deliberate reversal of the old "no browser can unpick the wall" shape, on the operator's explicit
  ask; its terms are: the browser **confirms** a shipped-deny strike before writing it (the one
  confirm on the policy page — it widens what every future run may do, the CLI-side settings
  included), the per-run push carve-out **never resurrects** a struck wall, and profiles still never
  move deny. `approvals.test.ts` pins all three.

### Flags gate capability, one act each

`--allow-writes` (scaffold plans/handoffs, record QA, take locks — never commits or pushes, `--git` is
never passed), `--allow-run` (spawn unattended `claude -p` sessions that edit a repo for hours),
`--allow-terminal` (a real shell), `--allow-agent` (interactive sessions and the plan wizard),
`--allow-accounts` (register Claude accounts for this instance, pick one per run, switch mid-run —
*reading* the usage meters needs no flag). All five default off. Shut down is deliberately *not*
behind a flag.

## Packaging, versions and releases

This tree ships through **four channels** — the Claude Code plugin (commit channel: **every push to
`main` is a release**, this repo is its own marketplace), the npm registry (`phase-console`,
prebuilt client, `vX.Y.Z` tags), GitHub Packages (`@zsarir/phase-console`, a tag-time mirror), and
the Homebrew tap (`zsarir/homebrew-tap`, follows npm). The full contract — how a change becomes an
update, and the release steps — is **`docs/releasing.md`**. The parts that bite:

- **Run `bash .github/scripts/scrub.sh` before every commit** (bare, never piped — failures are on
  stderr). Tokens go in gitignored `.secrets/` or Actions secrets, never the tree.
- A new server-runtime file (an import, a shelled script, a prompt-named reference) must be added to
  the root `package.json` `files` allowlist **and** `.github/scripts/assert-tarball.sh`.
- `npm pack` emits type-stripped `.js` beside every server `.ts` (Node refuses to strip under
  `node_modules`, where npm installs live); `postpack` deletes them. Never commit those `.js` files;
  never import `server/*.js` by hand — `fallback-sw.js` is the one real `.js` there.
- The Node floor (22.18+/23.6+) lives in five gates + docs — change it everywhere or nowhere
  (`docs/releasing.md` lists them).
- A package release = root `package.json` version bump + `CHANGELOG.md` section + `git tag vX.Y.Z`
  + a human `git push origin main vX.Y.Z`. Nothing pushes or publishes on its own.

## Docs and conventions

`README.md` is deliberately short — two copy-paste prompts and what the thing is. The long form is
`docs/` (indexed by `docs/README.md`); the console's own technical documentation is
`viewer/README.md`. English files have a Persian sibling (`README.fa.md`, `USAGE.fa.md`,
`viewer/README.fa.md`) — update both when changing either.

Commits use conventional prefixes with a human, declarative summary describing the change's *effect*
(`feat(run): automation defaults — opt-in skills, QA-on-launch, work branch + PR, repo guard`), not a
list of files touched.
