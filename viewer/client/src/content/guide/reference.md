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
| `--allow-agent` | Open interactive `claude` sessions — including recovery and QA reviews — and the *New plan with AI* wizard. |
| `--allow-terminal` | Open a shell in the browser. No deny list, no approval hook: whoever is at the keyboard is the policy. |
| `--port <n>` | Pin a port instead of deriving one from the repository path. |
| `--instance <sel>` | Act on a named console rather than the one for this directory. |
| `--remote <host>` | Also answer to this hostname, behind a proxy that authenticates callers. Turns on strict `Host` checking. |
| `--remote-user <login>` | A login allowed to arrive that way. Required by `--remote`. |
| `--scripts <dir>` | Use a different phased-execution checkout. |
| `--log-file <path>` | Structured log. Defaults under `~/.local/state/phase-console/`. |

## Console verbs

Every verb takes an optional instance selector — a name, an id or a unique folder name. With none,
it means the console for the directory you are in.

| Verb | Does |
|---|---|
| `phase-console start [sel]` | Start it — through its background agent if one is installed, in the foreground otherwise. |
| `phase-console list` | Every console: name, root, port, status, unit. |
| `phase-console open [sel]` | Open it in the browser. Refuses when it is stopped, and says how to start it. |
| `phase-console status [sel]` | With no selector, reports **all** consoles. |
| `phase-console stop \| restart \| logs [sel]` | The rest of the lifecycle, one console at a time. |

## Where things live

| Path | What is in it |
|---|---|
| `docs/plans/` | The plans. Yours, in git. |
| `docs/handoffs/` | Per-phase handoffs and locks. Yours, in git. |
| `~/.local/state/phase-console/` | Run checkpoints, journals, the log. Never inside your repository, so `git status` stays clean. Per-console state lives under `instances/<id>/`; the first console on a machine keeps the top-level paths it always had. |
| `~/.config/phase-console/` | Preferences — notification categories, push devices — and your autopilot policy. `instances.json` is the registry of every console: name, root, port, unit. |
| `.phase-console.json` | Optional, committed at a repository root: `{"name": …, "port": …}` names that project's console for everyone who clones it. |

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

## Status words

Four vocabularies coexist, on purpose, and they nest: a **plan** has a status (is anyone still
pursuing this at all), a **run** has a status (what the autopilot is doing with the plan right now),
each **phase in that run** has a record (what happened to it here), and the **board** states what is
true of a phase on disk — spelled the way a departures board would. Every badge in the app says this
on hover; this is the same text in one place.

### Plan status

The only one of the four that is *stored* rather than computed — because "does anyone still care?"
cannot be read off the files. The last three are **terminal**, which is what the app calls **closed**.

| Word | What it means | What to do |
|---|---|---|
| `active` | Live work. The plan asks for attention: ready phases, boot prompts, warnings, notifications. | Whatever the board says is boarding. |
| `complete` | Every phase landed and the work is finished. | Nothing — it has stopped asking. |
| `abandoned` | Dropped. It will not be finished, and that is a decision, not a failure. | Nothing. Reopen if it comes back. |
| `superseded` | Replaced by a different plan. The reason names the replacement. | Follow the plan that replaced it. |

A closed plan **goes quiet without going away**: no ready phases, no boot prompts, no session
batching, no stuck-handoff or QA-failure warnings, no notifications, and it leaves every portfolio
total. Its board still renders in full, search still finds it (with a `closed` badge), and real
structural damage is still reported — as a note rather than an error. Closing quiets a plan; it never
hides one.

Close or reopen it from the plan page (**⋯ ▸ Close plan**, which asks for a status and one line saying
why) or with `close-plan.sh`. Reopening is always available, so closing is a cheap, reversible call —
and a closed plan may perfectly well have unfinished phases, just as a plan with every phase done is
still open until somebody says otherwise.

### Run status

| Word | What it means | What to do |
|---|---|---|
| `running` | The autopilot is driving: sessions spawn, verify and hand off by themselves. | Nothing — watch the phase tabs. Pause, Freeze and Stop all apply. |
| `pausing` | A pause is armed: whatever is running finishes, and nothing new boards. | Wait for the boundary, or Cancel pause to keep going. |
| `paused` | Stopped between phases at your request; nothing is running. | Press Continue when ready — it picks up exactly where it left off. |
| `waiting` | Sleeping until the account's usage window reopens, then resumes itself. | Nothing. |
| `frozen` | The session is stopped where it stands (mid-token), warm and losing nothing. | Continue the frozen session to resume instantly, or Stop it. |
| `parked` | Every remaining phase needs a person first — a gate, an approval, a decision. | Read "Why this is stopped": each blocker is named with its remedy. |
| `queued` | In line behind another plan holding the same repos; starts itself when the scope frees. | Nothing — the holder is named on the queued chip. |
| `halting` | A halt was recorded; live sessions are finishing before the run fully stops. | Read the halt card. The run reads halted once the last session settles. |
| `halted` | Stopped on something that must not be automated past — usually a red verification. | Fix with AI on the halt card, or fix the cause yourself and Retry the phase. |
| `stopping` | A stop was requested; sessions are being wound down. | Wait a moment. |
| `finished` | Nothing left to run on this plan. | Nothing. |
| `interrupted` | Nothing is driving it and nothing recorded why — a console or session died mid-flight. | Resume with AI, or press Continue — work already on disk is kept. |

### Phase record (the "This run" column)

| Word | What it means | What to do |
|---|---|---|
| `pending` | This run has not started the phase yet. | Nothing — the loop reaches it when its dependencies are done. |
| `gated` | Parked at the plan's gate — a condition the plan reserves for a person. | Confirm the condition (the note quotes it), then Retry re-checks the gate. |
| `running` | A session is working this phase right now. | Watch its tab; Ask reaches the session mid-flight. |
| `verifying` | The session finished; the console runs the plan's §Verification commands itself. | Nothing — green marks it done, red halts with the evidence. |
| `awaiting-verification` | The machine checks passed; steps only a person can confirm remain. | Answer the verification card — it lists exactly what needs your eyes. |
| `done` | Finished and independently verified in this run. | Nothing. |
| `failed` | The attempt failed — a red verification, or a session that produced nothing. | Why? shows the evidence; Fix with AI repairs it, or Retry restarts the run here. |
| `interrupted` | The session or console died mid-phase; the working tree is wherever it stopped. | Resume with AI — uncommitted work is preserved, never redone blindly. |
| `skipped` | Taken off this run's list by the operator. | Retry it later if it should still happen. |
| `parked` | Needs a person before the loop will touch it again — the note says exactly why. | Read the note (gate, foreign lock, decision), act on it, then Retry. |
| `queued` | Waiting for repos another phase or plan is holding; starts itself when they free. | Nothing — the queued chip names what it waits on. |

A `failed` record under a phase the **board** calls done means: this run's attempt stopped, and
the work was finished and verified outside it. The row says "nothing to fix — done elsewhere".

### Board state (the "Status" column, departures spelling)

| State | On the board | What it means | What to do |
|---|---|---|---|
| `done` | **Departed** | The handoff is complete; the work is finished and verified. | Nothing. |
| `ready` | **Boarding** | Every dependency is met; this phase can start now. | Start it (or the autopilot will), or copy its boot prompt from the phase page. |
| `in-progress` | **On track** | A session is on this phase right now. | Watch its tab. The board catches up when the handoff lands. |
| `waiting` | **Held** | An earlier phase it depends on is not done yet. | Nothing here; finish what it waits on. |
| `stuck` / `blocked` | **Blocked** | Its handoff is marked blocked — the Outstanding section says exactly why. | Read the excerpt on the phase page, or Repair with AI on the run page. |
| `gated` | **Gated** | The plan reserves a decision for a person before this phase may run. | Confirm the gate condition (quoted on the phase page), then start or Retry. |

### Claim (the "Lock" column)

A claim is one session saying "I am working this phase". It lives in a file —
`docs/handoffs/<slug>/.locks/phase-NN.lock` — written by `phase-lock.sh claim`, and it carries a
**lease** (30 minutes by default) that the holder renews while it works. Every phase table shows it,
because it is the one fact that decides whether the buttons beside it do anything.

| State | Chip | What it means | What to do |
|---|---|---|---|
| `live` | **held by …** | Another session claimed this phase and its lease has not run out. Starting a second session here is refused — by this console and by the server. | Let it finish. If that session is gone, use **Release the claim** on the phase's row and confirm. |
| `stale` | **stale claim** | The lease lapsed: whoever took it stopped renewing, so nothing is working this phase. | Nothing, unless you want a tidy board — it does **not** block a run. **Release it** clears the file. |

A lapsed claim blocking work is the failure this distinction exists to prevent: a session that dies
without releasing would otherwise hold its phase for the full lease and then keep holding it, because
nothing renews a dead claim.
