# Using phased-execution (right-sized sessions, QA on request)

`phased-execution` **plans** large multi-phase work and **runs** it one right-sized session at a time —
several phases usually share a session (sized to ~0.2 × the model's window in phase weight; ~200K for
1M-class models), each phase still gets its own handoff, and a copy-pasteable boot prompt chains the
sessions. Every phase-finish runs the phase's own **Verification commands green** before handing off.

**QA subagents are opt-in (off by default).** When you ask for QA — a `**QA gate:** on` line in the
plan's §Session budget, `new-handoff.sh --qa` at a finish, or a plan that already has a
`test-status.md` — each finished phase is verified by a **fresh-context QA subagent** that reads the
real diff cold and records `pass | fail | waived`; a `fail` gates every dependent until re-QA'd.
`scripts/phase-graph.sh <slug> --qa-mode` tells you which regime a plan is in.

This file is a human-facing orientation. The executable procedure — the three modes, the helper scripts,
and the guardrails — lives in `SKILL.md` + `references/`; that is what Claude loads and follows.

## Seeing it all at once — the console

```bash
~/.claude/skills/phased-execution/start        # opens http://127.0.0.1:4123 in your browser
```

**Phase Console** (`viewer/`) is a local web app for reading this system: every plan with its live
board, the dependency graph drawn as a route map, phase and handoff detail, the boot prompt for any
ready phase, portfolio statistics (velocity, critical paths, locks, health), and full-text search
across plans and handoffs. It updates itself as agent sessions write files, and it takes every status
claim from `scripts/phase-graph.sh` rather than recomputing it. Read-only unless you pass
`--allow-writes`; it never commits or pushes. No install step — see `viewer/README.md`.

## Where things live (two places)

- **The skill** (this repo, cloned to `~/.claude/skills/phased-execution`): the procedure
  (`SKILL.md`), `scripts/`, `references/`, `templates/`, `tests/` and `viewer/`. If you run several
  Claude homes (`~/.claude`, `~/.claude-a`, …), each holds its own clone — edit one, then
  `commit → push → pull` in the others so all stay identical.
- **The work-state** (your project repo's `docs/`): `plans/<slug>.md` and
  `handoffs/<slug>/{phase-NN-*.md, INDEX.md, .locks/}` (+ `reports/` and `test-status.md` when QA is
  enabled) — committed + pushed, so any account or machine can pull and continue a partially-finished
  plan.

Full procedure: `SKILL.md` and its `references/`.
