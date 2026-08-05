# Reference

## How Agent Skills work

A [Skill](https://code.claude.com/docs/en/skills) is a folder with a `SKILL.md` whose frontmatter
(`name` + `description`) is the *only* part always loaded. Claude reads the full body **only when the
skill is relevant or invoked**, and bundled scripts run via Bash without their code ever entering the
context window. That is why a skill costs almost nothing until it is used — this one is **~190 tokens**
in every session, and ~9K only on the turns where it actually fires.

```
phased-execution/
├── SKILL.md          # frontmatter + the procedure Claude follows
├── USAGE.md          # human-facing orientation
├── start             # launch the console
├── bin/              # phase-console — the same launcher, on PATH for plugin installs
├── scripts/          # the engine and its helpers (run, don't read)
├── references/       # plan/handoff formats, conventions, sizing, QA method
├── templates/        # plan, handoff and INDEX scaffolds
├── tests/            # bats suite for the scripts
├── viewer/           # Phase Console — the local web app
└── .claude-plugin/   # marketplace.json — makes this repo installable as a plugin
```

There is deliberately no `plugin.json`. The marketplace entry carries the plugin's metadata itself
(`strict: false`), which keeps this folder a plain skill when you clone it — one tree, both install
paths, neither getting in the other's way. The root `package.json` is not a plugin manifest either:
it defines the **npm/Homebrew channel** (`phase-console` on the registry — prebuilt client, tagged
releases) and changes nothing about how the plugin or a clone behaves.

**▶ How the loop actually runs, in detail:** [USAGE.md](../USAGE.md).

# Requirements

**Bash** for the scripts — that is the whole skill. The console additionally needs **Node 22.18 or
newer (or 23.6+) with npm**: its server runs TypeScript directly, and its client is built once per
machine (`npm ci && npm run build` in `viewer/`; the console names those commands itself until they
have run — npm and Homebrew installs ship it prebuilt). Once built it bundles everything — fonts
included — so it works offline and installs to a phone's home screen. No service, no configuration
file.

**Platforms:** macOS and Linux are first-class — the background agent is launchd on one and a
systemd user service on the other. The terminal's native module (`node-pty`, optional) ships macOS
prebuilds and compiles during install on Linux when the distro's build tools are present
(`build-essential` + `python3` on Debian/Ubuntu); without it the console still runs and the
Terminal page says exactly what is missing. On Windows, run it inside **WSL2** (see
[install.md](install.md)); there is no native Windows build.

# Tests

```bash
tests/run-tests.sh                                        # the scripts (bats)
cd viewer && npm ci && npm test                           # the console (no build needed)
PHASE_CONSOLE_TEST_ROOT=~/code/your-repo npm test         # + engine parity, against a real plan library
npm run test:client                                       # the client suite (Vitest)
```

The parity test re-derives every plan's board from the console's own parser and asserts it matches the
engine. Run it after any change to a parser.

