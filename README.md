<div align="center">

# 🪜 phased-execution

**A [Claude Code](https://claude.com/claude-code) Agent Skill for running large work as a
dependency graph of right-sized sessions — with a local web console to watch it.**

![Skill](https://img.shields.io/badge/Claude%20Code-Agent%20Skill-d97757?style=flat-square)
![App](https://img.shields.io/badge/app-Phase%20Console-ffb627?style=flat-square)
![Dependencies](https://img.shields.io/badge/dependencies-none-3fb68b?style=flat-square)

</div>

---

## Quickstart

Two ways in. Same skill, same console — they differ only in how updates arrive and what you type.

**As a plugin** — one line, updates itself. Run these inside Claude Code:

```
/plugin marketplace add zsarir/phased-execution
/plugin install phased-execution@mobin
```

Then `phase-console` starts the app from any directory. The plugin is versioned by commit, so
`/plugin update phased-execution` always brings you current. Full detail, and what each command
actually does: [**Installing as a plugin**](#installing-as-a-plugin).

**As a plain skill** — a folder you own, on a path that never moves:

```bash
git clone https://github.com/zsarir/phased-execution.git ~/.claude/skills/phased-execution
~/.claude/skills/phased-execution/start
```

Update it with `git pull`.

Either way, `start` opens <http://127.0.0.1:4123> in your browser and asks which directory to read —
any repository containing `docs/plans`. Nothing to install, nothing to build, no configuration file:
the server is plain Node (22.6+, which runs TypeScript directly) and the page is native ES modules
with everything it needs vendored in this repo, so it works offline too.

Restart Claude Code and the skill is there. Cloned, it is `/phased-execution`. Installed as a plugin
it is `/phased-execution:phased-execution` — Claude Code namespaces every plugin skill under its
plugin to keep names from colliding, so type `/phased` and let autocomplete finish it. Most of the
time you never type either: the skill announces itself well enough that Claude reaches for it when
the work is phased.

---

## The problem

A big change does not fit in one session. Split it across many and you pay for it twice: each new
session re-reads everything to find its footing, and a session that runs too long loses the thread.
So the work needs a shape — small enough to hold, large enough to be worth starting, and written
down well enough that the next session can pick it up cold.

## The skill

Work is split into a **dependency graph of phases**. Each phase runs in a session that bootstraps
entirely from disk, and the engine computes which phases are **ready** from the done-set — so phases
can run out of order, and finishing one can unblock several. Sessions are sized to the running
model's budget and adjacent phases are **batched** into one when they fit, because a session boundary
costs a full bootstrap and should be earned: a spent budget, an external gate, or a deliberate model
switch.

Three artifacts, one job each — the same `<slug>` ties them together:

| Artifact | Lives at | Job |
|----------|----------|-----|
| **Plan** | `docs/plans/<slug>.md` | The durable roadmap: every phase, the dependency graph, self-contained per-phase detail and exit criteria. |
| **Handoff** | `docs/handoffs/<slug>/phase-NN-*.md` + `INDEX.md` | The baton that boots the *next* cold session: state now, files changed, decisions, the exact next command. |
| **Memory** | the memory index (`project_<slug>`) | Durable cross-session facts — status, commits, gates, gotchas. |
| **QA status** *(opt-in)* | `docs/handoffs/<slug>/test-status.md` + `reports/` | Per-phase QA verdicts that **gate dependents**. Off by default. |

Three modes:

```bash
/phased-execution    # plan         → author the plan, then implement Phase 1 in this session
/phased-execution    # phase-start  → bootstrap + lock a phase in a fresh session
/phased-execution    # phase-finish → verify + commit + handoff + memory + next-phase prompts
```

**Status is computed, never stored as a cursor.** `scripts/phase-graph.sh <slug>` reads the plan's
dependency table and every handoff's front matter and prints the live board — done, in progress,
ready, waiting — plus the suggested session batches. Nothing else is allowed to claim otherwise.

Also bundled: per-phase **locking** so two sessions never build the same phase, deterministic
**validation** (`validate.sh` catches malformed rows, undefined dependencies, cycles and handoffs
that disagree with the graph), machine-checkable **gates**, and an opt-in fresh-context **QA
subagent** that reviews a phase's real diff before its dependents start.

**▶ How the loop actually runs:** [USAGE.md](USAGE.md).

---

## 🚉 Phase Console

> *The whole plan library in one page.*

```bash
./start                      # pick the directory in the browser
./start ~/code/your-repo     # or name it up front
./start --allow-writes       # plus the guarded write verbs
```

Installed as a plugin, the same command is `phase-console` and works from anywhere.

A plan library outgrows a terminal: dozens of plans, hundreds of phases, hundreds of handoff files —
and the engine answers for exactly one plan at a time. The console is the portfolio view: what is
ready **right now** across every plan, which lock is holding what, which plan has stalled, how much
work is left, and whether a plan's graph even lints.

| Screen | Contents |
|---|---|
| **Source** | Pick any repository with `docs/plans`. Recent choices are remembered, and you can switch at any time from the left rail. |
| **Plans** | Every plan with progress, ready phases, locks, QA regime and health. Newest activity first; filter by status, ready, locked or repo. |
| **Route** | The plan as a transit map — phases are stations, dependencies are track, and each suggested session batch is a train threading the stations it carries. |
| **Departures** | The board: state, size, dependencies, gates, locks and QA for every phase. |
| **Phase** | Goal, read-first, files, steps, exit criteria, verification — plus that phase's handoff, gate status, lock and its **boot prompt**, ready to copy into a fresh session. |
| **Handoffs** | Every handoff with its front-matter contract, body and the boot prompts it generated. |
| **Analysis** | Critical path, bottleneck, best next phase, remaining weight and sessions, completion timeline, QA table, health issues. |
| **Ready now** | Every ready phase across every plan, ranked by how much it unblocks. |
| **Statistics** | Portfolio totals, velocity, completions calendar, size mix, repos, skills, target models, locks and every health issue. |
| **Search** | Full text across all plans and handoffs, grouped by plan. |

It **updates itself**: a watch on `docs/` pushes changes over server-sent events, so a handoff written
by an agent session appears without a reload.

**One rule governs the design.** `phase-graph.sh` is the only source of truth for done / ready /
waiting, session batches, boot prompts, QA regime and lint — the console shells out to these same
scripts for every status claim and never recomputes it. JavaScript parsing covers only what the
scripts do not expose (prose sections, phase detail, handoff bodies) plus analysis they do not provide
(critical path, unblock value, velocity). A parity test re-derives every plan's board from that parse
and asserts it matches the engine, so the two readings cannot drift apart unnoticed.

**Writes are off by default.** With `--allow-writes` the console can scaffold a plan or handoff,
record a QA result and manage phase locks — each behind a dialog showing the exact command first.
`--git` is never passed, so it can never commit or push. The server binds to `127.0.0.1` only.

Details: [viewer/README.md](viewer/README.md).

---

## How Agent Skills work

A [Skill](https://docs.claude.com/en/docs/claude-code/skills) is a folder with a `SKILL.md` whose
frontmatter (`name` + `description`) is the *only* thing always loaded — Claude reads the full body
**only when the skill is relevant or invoked**. Bundled `scripts/` run via Bash without their code
ever entering the context window. That is why a skill costs almost nothing until it is used.

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
paths, neither getting in the other's way.

---

## Installing as a plugin

Two words to keep straight. A **plugin** is the package — skills, and optionally agents, hooks and
executables, in one directory. A **marketplace** is a catalog that lists plugins and says where to
fetch them. They are separate things, and installing takes one command for each. This repo is both:
it ships a catalog called **`mobin`** listing exactly one plugin, itself.

### 1 · Register the marketplace

Inside Claude Code:

```
/plugin marketplace add zsarir/phased-execution
```

Claude Code clones the repository, validates the catalog inside it and remembers it as `mobin`.
Nothing is installed yet — a marketplace is only a list.

`owner/repo` shorthand clones over SSH. If you would rather it used HTTPS, set
`CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` in your environment first, or pass the full URL instead:
`/plugin marketplace add https://github.com/zsarir/phased-execution.git`.

### 2 · Install the plugin

```
/plugin install phased-execution@mobin
```

The `@mobin` suffix names the catalog to install from — it matters once you have several registered
and two of them list the same plugin name. Claude Code copies the plugin into its own cache under
`~/.claude/plugins/cache/mobin/phased-execution/<commit>/`, keyed by the commit it came from.

### 3 · Load it

```
/reload-plugins
```

Or restart Claude Code. Confirm it took with `/plugin`, which lists what is installed and has an
**Errors** tab if anything failed to load.

From a terminal, `claude plugin details phased-execution@mobin` prints the same thing plus what it
costs you: **~190 tokens always-on** (the skill's name and description, in every session) and ~9k
only on the turns where the skill actually fires.

### What you get

**The skill**, as `/phased-execution:phased-execution`. Claude Code namespaces every plugin skill
under its plugin so two plugins can ship a `review` skill without clashing; here that reads as a
stutter. Type `/phased` and let autocomplete finish it — and note you will rarely type it at all,
because the skill's description is written to make Claude reach for it on its own when the work is
phased.

**The console**, as `phase-console` — from any directory, no path to remember:

```bash
phase-console                      # pick the plan directory in the browser
phase-console ~/code/your-repo     # or name it up front
phase-console --allow-writes       # plus the guarded write verbs
```

Claude Code puts an enabled plugin's `bin/` on the Bash tool's `PATH`, which is what makes that a
bare command. Disable the plugin and it goes away with it.

### Updating

```
/plugin update phased-execution
```

Because the manifest sets no `version`, the plugin is versioned by **commit SHA**: every push to
`main` counts as a new release, and Claude Code also refreshes in the background. Restart to apply
an update — the cache directory is per-version, so a running session keeps working from the copy it
already loaded.

### Removing

```
/plugin uninstall phased-execution@mobin
/plugin marketplace remove mobin
```

The second line is optional; leaving the catalog registered costs nothing and makes reinstalling one
command.

### From a terminal instead

Every step has a non-interactive equivalent, useful in a dotfiles script or a container image:

```bash
claude plugin marketplace add zsarir/phased-execution
claude plugin install phased-execution@mobin
claude plugin details phased-execution@mobin      # components + token cost
claude plugin update phased-execution
claude plugin uninstall phased-execution@mobin
```

### Plugin or clone?

|  | Plugin | Clone |
|---|---|---|
| **Install** | two commands, inside Claude Code | one `git clone` |
| **Updates** | automatic, every commit | when you `git pull` |
| **Skill** | `/phased-execution:phased-execution` | `/phased-execution` |
| **Console** | `phase-console`, from anywhere | `./start`, from the folder |
| **Lives at** | a per-version cache directory that moves on every update | wherever you cloned it, permanently |
| **Suits** | wanting it present and current, with nothing to maintain | scripting against the path, or editing the skill itself |

Both at once works, but you would see the skill twice in the catalog and pay its always-on cost
twice. Pick one.

## Requirements

Node 22.6 or newer (for the console) and Bash (for the scripts). Nothing else — no npm install, no
build step, no service to run.

## Tests

```bash
tests/run-tests.sh                                                      # the scripts (bats)
cd viewer && node --test "test/*.test.ts"                               # the console
PHASE_CONSOLE_TEST_ROOT=~/code/your-repo node --test "test/*.test.ts"   # + engine-parity, against a real plan library
```

---

<div align="center">
<sub>Skills are loaded on demand — the name is always in the catalog, the procedure only when invoked.</sub>
</div>
