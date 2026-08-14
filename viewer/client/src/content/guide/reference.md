## Console flags

All five capability switches are off unless named. Flags are read once, at startup.

| Flag | Meaning |
|---|---|
| `--root <dir>` / `-r` | Open this repository immediately, skipping the picker. |
| `--allow-writes` | Scaffold plans and handoffs, record QA, take locks, close and reopen plans. Never commits, never pushes. |
| `--allow-run` | Enable the autopilot. Separate from writes on purpose. |
| `--allow-terminal` | Open a shell in the browser. No deny list, no approval hook: whoever is at the keyboard is the policy. |
| `--allow-agent` | Interactive `claude` sessions — including recovery and QA reviews — and the *New plan with AI* wizard. |
| `--allow-accounts` | Register Claude accounts and choose one per run. The usage meters need no flag. |
| `--port <n>` / `-p` | Pin a port instead of deriving one from the repository path. Never probed past. |
| `--host <addr>` | The bind address. Defaults to `127.0.0.1` and there is no good reason to change it — see **Mobile setup**. |
| `--no-open` | Do not open a browser on start. `PHASE_CONSOLE_NO_OPEN=1` does the same. |
| `--instance <sel>` | Act on a named console rather than the one for this directory. |
| `--remote <host>` | Also answer to this hostname, behind a proxy that authenticates callers. Turns on strict `Host` checking. |
| `--remote-user <login>` | A login allowed to arrive that way. **Required** by `--remote`. |
| `--max-sessions <n>` | Global ceiling on concurrent sessions. Default 3; a run may ask for fewer, never more. |
| `--default-skills <csv>` | Skills seeded into every new run. Repeatable and additive — unticking one in the console is still a real off. |
| `--scripts <dir>` | Use a different phased-execution checkout. |
| `--log-file <path>` / `--no-log-file` | Structured log destination. Defaults under `~/.local/state/phase-console/`. |

## Environment variables

| Variable | Does |
|---|---|
| `PHASE_CONSOLE_NOTIFY` | A command run as `cmd "<title>" "<body>"` for every announcement. Environment-only on purpose. |
| `PHASE_CONSOLE_URL` | Which console `btw` talks to. |
| `PHASE_CONSOLE_HOME` | Where the console's own install lives, for the launcher and the CLI. |
| `PHASE_CONSOLE_REMOTE_USERS` | Comma-separated logins, the same as repeating `--remote-user`. |
| `PHASE_CONSOLE_MAX_SESSIONS` | The default for `--max-sessions`. |
| `PHASE_CONSOLE_DEFAULT_SKILLS` | The default for `--default-skills`. |
| `PHASE_CONSOLE_NO_OPEN` | `1` suppresses the browser launch. |
| `PHASE_CONSOLE_LOG` | The default log path; empty disables the file. |
| `PHASE_EXEC_GATES` | `1` lets `cmd` gate checks actually run a command. |

## Console verbs

Every verb takes an optional instance selector — a name, an id or a unique folder name. With none, it
means the console for the directory you are in.

| Verb | Does |
|---|---|
| `phase-console start [sel]` | Start it — through its background agent if one is installed, in the foreground otherwise. |
| `phase-console list` | Every console: name, root, port, status, unit. |
| `phase-console open [sel]` | Open it in the browser. Refuses when stopped, and says how to start it. |
| `phase-console status [sel]` | With no selector, reports **all** consoles. |
| `phase-console stop \| restart \| logs [sel]` | The rest of the lifecycle, one console at a time. |
| `phase-console update` | Rebuild and restart. On an npm or Homebrew install it tells you to update the package instead. |
| `phase-console install-skill` | Put the skill files where Claude Code reads them. For npm and Homebrew installs. |
| `phase-console --install-agent --root <repo>` | Install the login agent — launchd or systemd — with the flags you name. |

`./start` is the clone's equivalent, but it takes a **repository, not a verb**: its first bare
argument becomes `--root`. Use `viewer/run <verb>` or `phase-console <verb>` for the lifecycle.

## Gate checks

Add `- **Gate-check:** <type> …` to a phase to say what holds it up — and **who can clear it**. An
`ai` gate is cleared by the booted session itself; a `manual` gate waits for a person; the rest clear
themselves.

| Syntax | Category | Clears when |
|---|---|---|
| `ai <check>` | ai | A booted session verifies the plan's Gates conditions, does the work to make them true, and records the clearance — or you approve it. Prefer this. |
| `manual <who>` | human | Never by itself. A person does the Gates bullet's numbered steps, then approves on the phase page's Gate card. |
| `phase 8` | auto | Phase 8 of this plan is done. |
| `phases 6,7,9` | auto | All of them are done. |
| `plan other-slug:6,8` | auto | Those phases in a different plan are done. |
| `date 2026-12-01` | auto | On or after that date. Range-checked, so a nonsense date fails closed. |
| `deadline 2026-12-01` (or `by …`) | auto | Only before that date — after it the gate reads OVERDUE. |
| `cmd <command>` | auto | The command exits 0. **The autopilot evaluates it (`PHASE_EXEC_GATES=1`); page views never execute it** — running a command written in a document is worth an explicit opt-in. |

**Approving** — the phase page's Gate card, or `scripts/gate-approve.sh <slug> <N> --by <who>` —
clears a gate of **any** kind: the row lands in `docs/handoffs/<slug>/gate-status.md`, and revoking
it restores the gate. A `*(GATED)*` heading with no Gate-check at all reads as a human gate, the safe
default.

## Where things live

| Path | What is in it |
|---|---|
| `docs/plans/` | The plans. Yours, in git. |
| `docs/handoffs/` | Per-phase handoffs and locks. Yours, in git. |
| `~/.local/state/phase-console/` | Run checkpoints, journals, the log. Never inside your repository, so `git status` stays clean. Per-console state lives under `instances/<id>/`; the first console on a machine keeps the top-level paths it always had. |
| `~/.config/phase-console/` | Preferences — notification categories, push devices — and your autopilot policy. `instances.json` is the registry of every console: name, root, port, unit. |
| `.phase-console.json` | Optional, committed at a repository root: `{"name": …, "port": …}` names that project's console for everyone who clones it. |

## The engine, if you would rather drive it yourself

Everything the console shows comes from these scripts. It never recomputes status in the browser, so
what you see here and what you get in a terminal cannot disagree.

```bash
scripts/phase-graph.sh <slug>              # the board
scripts/validate.sh <slug>                 # lint the plan
scripts/phase-lock.sh <slug> status N      # who is working this phase
scripts/qa-record.sh <slug> N pass --report …   # record a QA result
```

The full set — boot prompts, session batching, gate status, handoff scaffolding — is in
`docs/controls.md`.

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

## The five vocabularies

They coexist on purpose, and they nest. A **plan** has a status (is anyone still pursuing this at
all). A **run** has a status (what the autopilot is doing with it right now). Each **phase in that
run** has a record (what happened to it here). The **board** states what is true of a phase on disk,
spelled the way a departures board would. And a **claim** says whether somebody is already working it.

Every badge in the app says this on hover; the tables below are the same text in one place.

## Plan status

The only one that is *stored* rather than computed — "does anyone still care?" cannot be read off the
files. The last three are **terminal**, which is what the app calls **closed**.

| Word | What it means | What to do |
|---|---|---|
| `active` | Live work. The plan asks for attention: ready phases, boot prompts, warnings, notifications. | Whatever the board says is boarding. |
| `complete` | Every phase landed and the work is finished. | Nothing — it has stopped asking. |
| `abandoned` | Dropped. It will not be finished, and that is a decision, not a failure. | Nothing. Reopen if it comes back. |
| `superseded` | Replaced by a different plan. The reason names the replacement. | Follow the plan that replaced it. |

A closed plan **goes quiet without going away**: no ready phases, no boot prompts, no notifications,
and it leaves every portfolio total. Its board still renders, search still finds it, and real
structural damage is still reported. Close or reopen from **⋯ ▸ Close plan** — reopening is always
available, so closing is a cheap, reversible call.

## Run status

| Word | What it means | What to do |
|---|---|---|
| `running` | The autopilot is driving: sessions spawn, verify and hand off by themselves. | Nothing — watch the phase tabs. Pause, Freeze and Stop all apply. |
| `pausing` | A pause is armed: whatever is running finishes, and nothing new boards. | Wait for the boundary, or Cancel pause to keep going. |
| `paused` | Stopped between phases at your request; nothing is running. | Press Continue when ready — it picks up exactly where it left off. |
| `waiting` | Sleeping until the account's usage window reopens, then resumes itself. | Nothing. |
| `frozen` | Every session is stopped where it stands (mid-token), warm and losing nothing. A freeze on ONE session of several is recorded on that session's tab instead, and the run stays `running`. | Continue the frozen session to resume instantly, or Stop it. |
| `parked` | Every remaining phase needs a person first — a gate, an approval, a decision. | Read "Why this is stopped": each blocker is named with its remedy. |
| `queued` | In line behind another plan holding the same repos; starts itself when the scope frees. | Nothing — the holder is named on the queued chip. |
| `halting` | A halt was recorded; live sessions are finishing before the run fully stops. | Read the halt card. The run reads halted once the last session settles. |
| `halted` | Stopped on something that must not be automated past — usually a red verification. | 'Finish in its own session' or 'Fix with a new agent' on the halt card, or fix the cause yourself and Retry the phase. |
| `stopping` | A stop was requested; sessions are being wound down. | Wait a moment. |
| `finished` | Nothing left to run on this plan. | Nothing. |
| `interrupted` | Nothing is driving it and nothing recorded why — a console or session died mid-flight. | Resume with AI, or press Continue — work already on disk is kept. |

## Phase record

The "This run" column: what happened to a phase *in this run*, as opposed to what is true of it on
disk.

| Word | What it means | What to do |
|---|---|---|
| `pending` | This run has not started the phase yet. | Nothing — the loop reaches it when its dependencies are done. |
| `gated` | Held at the plan's gate — a human or automatic condition the run cannot clear itself (ai gates never park: their session is booted to clear them). | Do the gate's steps and Approve on the phase page's Gate card (it can continue the run in the same action), or Retry to re-check. |
| `running` | A session is working this phase right now. | Watch its tab; Ask reaches the session mid-flight. |
| `verifying` | The session finished; the console runs the plan's verification commands itself. | Nothing — green marks it done, red halts with the evidence. |
| `awaiting-verification` | The machine checks passed; steps only a person can confirm remain. | Answer the verification card — it lists exactly what needs your eyes. |
| `done` | Finished and independently verified in this run. | Nothing. |
| `failed` | The attempt failed — a red verification, or a session that produced nothing. | Why? shows the evidence; 'Fix with a new agent' repairs it, or Retry restarts the run here. |
| `interrupted` | The session or console died mid-phase — or the operator stopped this one session from its tab; the working tree is wherever it stopped. | Resume with AI or Retry — the session id is kept, and uncommitted work is preserved, never redone blindly. |
| `skipped` | Taken off this run's list by the operator. | Retry it later if it should still happen. |
| `parked` | Needs a person before the loop will touch it again — the note says exactly why. | Read the note (gate, foreign lock, decision), act on it, then Retry. |
| `queued` | Waiting for repos another phase or plan is holding; starts itself when they free. | Nothing — the queued chip names what it waits on. |

A `failed` record under a phase the **board** calls done means: this run's attempt stopped, and the
work was finished and verified outside it. The row says "nothing to fix — done elsewhere".

## Board state

The "Status" column, in departures spelling.

| State | On the board | What it means | What to do |
|---|---|---|---|
| `done` | **Departed** | The handoff is complete; the work is finished and verified. | Nothing. |
| `ready` | **Boarding** | Every dependency is met; this phase can start now. | Start it (or the autopilot will), or copy its boot prompt from the phase page. |
| `in-progress` | **On track** | A session is on this phase right now. | Watch its tab. The board catches up when the handoff lands. |
| `waiting` | **Held** | An earlier phase it depends on is not done yet. | Nothing here; finish what it waits on. |
| `stuck` / `blocked` | **Blocked** | Its handoff is marked blocked — the Outstanding section says exactly why. | Read the excerpt on the phase page, or 'Repair the plan with a new agent' right on the phase page. |
| `gated` | **Gated** | The plan gates this phase — on a person (`manual`), a session's own check (`ai`), or an automatic condition. | The phase page's Gate card shows the steps and the Approve button; ai gates clear themselves when their session boots. |

## The claim

A claim is one session saying "I am working this phase". It lives in a file —
`docs/handoffs/<slug>/.locks/phase-NN.lock` — written by `phase-lock.sh claim`, and carries a
**lease** (30 minutes by default) that the holder renews while it works. Every phase table shows it,
because it is the one fact that decides whether the buttons beside it do anything.

| State | Chip | What it means | What to do |
|---|---|---|---|
| `live` | **held by …** | Another session claimed this phase and its lease has not run out. Starting a second session here is refused — by this console and by the server. | Let it finish. If that session is gone, use **Release the claim** on the phase's row and confirm. |
| `stale` | **stale claim** | The lease lapsed: whoever took it stopped renewing, so nothing is working this phase. | Nothing, unless you want a tidy board — it does **not** block a run. **Release it** clears the file. |

A lapsed claim blocking work is the failure this distinction exists to prevent: a session that dies
without releasing would otherwise hold its phase for the full lease and then keep holding it, because
nothing renews a dead claim.
