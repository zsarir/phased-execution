## Gate checks

Add `- **Gate-check:** <type> …` to a phase to say what holds it up. A gate the machine can read
clears itself; one it cannot waits for you.

| Syntax | Clears when |
|---|---|
| `phase 8` | Phase 8 of this plan is done. |
| `phases 6,7,9` | All of them are done. |
| `plan other-slug:6,8` | Those phases in a different plan are done. |
| `date 2026-12-01` | On or after that date. Range-checked, so a nonsense date fails closed. |
| `cmd <command>` | The command exits 0. **Off unless `PHASE_EXEC_GATES=1`** — running a command written in a document is worth an explicit opt-in. |
| `manual <who>` | Never by itself. A person decides. |

## Console flags

| Flag | Meaning |
|---|---|
| `--root <dir>` | Open this repository immediately, skipping the picker. |
| `--allow-writes` | Enable scaffolding, QA records and locks. |
| `--allow-run` | Enable the autopilot. Separate on purpose. |
| `--port <n>` | Listen somewhere other than 4123. |
| `--remote <host>` | Also answer to this hostname, behind a proxy that authenticates callers. Turns on strict `Host` checking. |
| `--remote-user <login>` | A login allowed to arrive that way. Required by `--remote`. |
| `--scripts <dir>` | Use a different phased-execution checkout. |
| `--log-file <path>` | Structured log. Defaults under `~/.local/state/phase-console/`. |

## Where things live

| Path | What is in it |
|---|---|
| `docs/plans/` | The plans. Yours, in git. |
| `docs/handoffs/` | Per-phase handoffs and locks. Yours, in git. |
| `~/.local/state/phase-console/` | Run checkpoints, journals, the log. Never inside your repository, so `git status` stays clean. |
| `~/.config/phase-console/` | Preferences and your autopilot policy. |

## The engine, if you would rather drive it yourself

Everything the console shows comes from these. It never recomputes status in the browser, so what
you see here and what you get in a terminal cannot disagree.

```bash
scripts/phase-graph.sh <slug>                  # the board
scripts/phase-graph.sh <slug> --boot-prompt N  # the prompt for one phase
scripts/phase-graph.sh <slug> --session-plan   # which phases to batch
scripts/phase-graph.sh <slug> --gate-status N  # is this phase held up
scripts/validate.sh <slug>                     # lint the plan
scripts/new-handoff.sh <slug> N title complete # scaffold a handoff
scripts/phase-lock.sh <slug> status N          # who is working this phase
scripts/qa-record.sh <slug> N pass --report …  # record a QA result
scripts/next-phase-prompt.sh <slug> N          # the stop banner + boot prompts
```

## Keyboard

| Key | Goes to |
|---|---|
| `/` | Search |
| `r` | Ready now |
| `p` | Plans |
| `d` | Dashboard |
| `s` | Statistics |
| `g` | Guide |
| `n` | Notifications |
| `Esc` | Close a dialog |
