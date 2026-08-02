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
`/plugin update phased-execution` always brings you current.

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

The repo is its own one-plugin marketplace: `.claude-plugin/marketplace.json` declares the plugin
(`strict: false`, so no separate `plugin.json` is needed and the folder stays a plain skill when you
clone it). No `version` field is set, which puts the plugin on the commit channel — every push to
`main` is an update.

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
