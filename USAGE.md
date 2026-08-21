# Using phased-execution (right-sized sessions, QA on request)

**English** · [فارسی](USAGE.fa.md)

`phased-execution` **plans** large multi-phase work and **runs** it in right-sized sessions — several
phases usually share a session (sized to ~0.2 × the model's window in phase weight; ~200K for 1M-class
models), each phase still gets its own handoff, and a copy-pasteable boot prompt chains the sessions.
Phases whose **scopes are disjoint** (the repos each touches, from the plan's Repos column) may run as
separate sessions at the same time; anything sharing a repo runs one at a time. Every phase-finish runs
the phase's own **Verification commands green** before handing off.

**QA subagents are opt-in (off by default).** When you ask for QA — a `**QA gate:** on` line in the
plan's §Session budget, `new-handoff.sh --qa` at a finish, or a plan that already has a
`test-status.md` — each finished phase is verified by a **fresh-context QA subagent** that reads the
real diff cold and records `pass | fail | waived`; a `fail` gates every dependent until re-QA'd — or
until the plan is **closed**, which retires its reports without pretending they passed.
`scripts/phase-graph.sh <slug> --qa-mode` tells you which regime a plan is in.

**A plan you will never finish can be closed.** `scripts/close-plan.sh <slug> --reason "…"` marks it
`abandoned` (or `superseded`, or `complete`) with a date and a reason; `--reopen` reverses it. A closed
plan stops reporting ready phases, boot prompts, warnings and notifications, while its board, its
history and its search results stay exactly where they were — closing quiets a plan, it never hides one.

This file is a human-facing orientation. The executable procedure — the three modes, the helper scripts,
and the guardrails — lives in `SKILL.md` + `references/`; that is what Claude loads and follows.

## Seeing it all at once — the console

```bash
~/.claude/skills/phased-execution/start        # opens http://127.0.0.1:4123 in your browser
phase-console                                  # same thing, when installed as a plugin, via npm or via brew

cd ~/code/your-repo && phase-console start     # a console for THIS project, on its own port
phase-console list                             # every console: name, root, port, status
```

**Phase Console** (`viewer/`) is a local web app for reading this system: every plan with its live
board, the dependency graph drawn as a route map, phase and handoff detail, the boot prompt for any
ready phase, portfolio statistics (velocity, critical paths, locks, health), and full-text search
across plans and handoffs. It updates itself as agent sessions write files, and it takes every status
claim from `scripts/phase-graph.sh` rather than recomputing it. Read-only unless you pass
`--allow-writes` (guarded scaffold / QA / lock / close verbs), `--allow-run` (the **autopilot** — one
`claude -p` per phase, driving a plan unattended, with approvals for anything reaching outside the
working tree), `--allow-agent` (the **Agent** page — interactive `claude` sessions in a browser
terminal, plus a *New plan with AI* wizard that authors a plan from a brief),
`--allow-accounts` (register several **Claude accounts** per instance — sign-ins or
`claude setup-token` tokens — pick one per run, and let a run that hits its usage limit switch to
the account with headroom; the usage meters themselves need no flag),
`--allow-mcp` (register **MCP servers** — a browser, an issue tracker, a docs server — hold their
credentials, and attach them to a plan, a run or one phase; a phase whose servers cannot connect
runs without them and says so — or parks *before* it spends anything, if the plan or the run asks
for that — and reading the registry and its statuses needs no flag), or
`--allow-terminal` (a real shell); it never commits or pushes. One-time setup per machine:
`cd viewer && npm ci && npm run build` — skipped entirely on an npm or Homebrew install, which ships
the client prebuilt — see `viewer/README.md`.

**It heals its own runs, and asks once.** A phase that stopped short is classified (never started,
work in progress, done but unrecorded, verification red, declared blocked, a resource wall, a stale
or live foreign claim, a manual gate…) and its situation's ladder is climbed by the autopilot itself —
at boot, on a docs change, every few minutes, a minute after any stop, and on Recover & continue —
within caps in rungs **and** dollars you set in Settings ▸ Automation; when the ladder is spent it
leaves **one errand** (what is needed, how to give it, what it tried) and drives everything else.
Every Ways forward shows the situation, the rungs tried and the next one; the dashboard's *Waiting on
you* lists only errands, permission cards and sign-ins; the Pulse shows each plan's last convergence
pass. Install the session-presence hook (Settings ▸ Session presence or `phase-console
install-hooks`) and a hand-run `claude` in the repository is seen too — queued behind while it lives,
its lock released the moment it ends. `docs/loop.md` is the specification.

**One install serves every project.** Each repository gets its own console — its own port, state and
supervisor — from the single install you already have; `phase-console list` shows them, and every
verb (`open`, `stop`, `restart`, `status`, `logs`) takes the name of one. The first console on a
machine keeps port 4123 and the paths it always used, so upgrading changes nothing for one project.

## Where things live (two places)

- **The skill** (this repo — cloned to `~/.claude/skills/phased-execution`, installed as a plugin,
  or packaged by npm/Homebrew): the procedure (`SKILL.md`), `scripts/`, `references/`, `templates/`,
  `tests/` and `viewer/`. If you run several Claude homes (`~/.claude`, `~/.claude-a`, …), each
  holds its own clone — edit one, then `commit → push → pull` in the others so all stay identical.
- **The work-state** (your project repo's `docs/`): `plans/<slug>.md` and
  `handoffs/<slug>/{phase-NN-*.md, INDEX.md, .locks/}` (+ `reports/` and `test-status.md` when QA is
  enabled) — committed + pushed, so any account or machine can pull and continue a partially-finished
  plan.

Full procedure: `SKILL.md` and its `references/`.
