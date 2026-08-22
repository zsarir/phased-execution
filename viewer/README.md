# Phase Console

**English** · [فارسی](README.fa.md)

A local web console for phased execution: browse plans, phases and handoffs, see live status,
copy the boot prompt for any ready phase, and read statistics across the whole plan library.

## Start it

```bash
cd viewer && npm ci && npm run build && cd ..   # once per machine, and after an update
./start                                         # from the skill directory — opens your browser
phase-console                                   # from anywhere: plugin, npm or Homebrew install
```

The server is plain Node (22.18+, or 23.6+ — it runs TypeScript directly, nothing to compile). The
client is **built output**: a Vite/React app whose `client/dist` is gitignored, so every machine
builds its own copy once — except npm and Homebrew installs, whose tarball ships it prebuilt. Skip
the build and the console still answers — with a page naming the two commands and the exact
directory — and `npm start` warns when the built client is older than the code. Nothing ever builds
implicitly: what serves is always what you last deliberately built. Once built, it works offline and
installs to a phone's home screen.

The first screen asks which directory to read — any repository containing `docs/plans`. It remembers
the ones you pick, and you can switch at any time from the **Source** panel in the left rail or from
**Settings → Source**. To skip the picker, name the directory up front:

```bash
./start ~/code/your-repo      # open this plan library straight away
./start --allow-writes        # also enable the guarded write verbs
./start --port 8080 --no-open # pin a port, don't open a browser
```

**One install serves every project.** A console belongs to a repository root, and its identity is
derived from that path, so the same project is always the same console. `cd` into a repository and
`phase-console start` gives it its own port, its own state directory and its own supervisor while
your other projects keep running; `phase-console list` shows them all, and `open`, `status`, `stop`,
`restart` and `logs` each take a selector (a name, an id, a unique folder name, or `--root <dir>`)
and otherwise mean the console for the directory you are in. The first console on a machine keeps
port 4123, the plain unit name and the state paths it always had — a single-project install gains no
new files. Everything else is in [`shared/instances.mjs`](shared/instances.mjs): the registry at
`~/.config/phase-console/instances.json`, the derived-port range 4124–4223, and the precedence chain
`--port` → `PHASE_CONSOLE_PORT` → the project's `.phase-console.json` → the port it last actually
bound → derived.

## Keep it running

A foreground console dies with its terminal, with a logout, and with any crash.
Install it as a background agent instead — launchd on macOS, a systemd user service on Linux —
and it starts at login and comes back on its own:

```bash
./start --install-agent --root ~/code/your-repo
./start --agent-status      # is it up, and as which pid
./start --agent-log -f      # follow the structured log
./start --agent-start       # start it (stopped ≠ uninstalled)
./start --agent-stop        # stop it — it stays installed and returns at login
./start --agent-restart
./start --agent-update      # after a git pull: npm ci + npm run build, then restart
./start --uninstall-agent
```

(On an npm or Homebrew install the same verbs are friendlier words on the bin:
`phase-console --install-agent --root ~/code/your-repo`, then `phase-console
start | stop | restart | status | logs [-f]` — `start` runs in the foreground when no agent is
installed. Updates come through the package manager — `npm update -g phase-console` /
`brew upgrade phase-console`, then `phase-console restart`.)

`--install-agent` and `--agent-update` build the client as part of the job; the supervisor's boot
path never builds, so a restart serves exactly what was verified and a crash loop cannot spend its
throttle interval rebuilding.

It also tries not to fall over in the first place. An unhandled fault, a file watch that
errors, a browser that vanishes mid-stream — each is recorded as **degraded** state and
served through `/api/state` rather than ending the process. The file watch checks itself
every minute and rebuilds if it has gone deaf, because a frozen board looks exactly like a
working one. Every exit writes down its reason to
`~/.local/state/phase-console/console.log`, and a run that wrote none is reported as a
crash the next time the console starts — so "it just stopped" is a question the log can
answer.

## Stop it

**Settings → Shut down** ends the console and everything it owns. Under launchd that means
`launchctl bootout`, and under systemd `systemctl --user stop` — the job is unloaded and *stays*
off; otherwise `KeepAlive` / `Restart=always` would turn the exit into a restart, which is why the
console had a Restart button and no Stop one for so long. Anywhere else it is a graceful exit.

The confirm dialog is an inventory rather than a warning: it lists the run it is about to stop (which
is checkpointed first and resumes when the console comes back), each live agent session, each
terminal, and the command that brings it all back. Restart shows the same list — it has always killed
every pty on the way out and never said so. Shut down is deliberately **not** behind `--allow-run`:
the one thing every console must be able to do is stop.

## What it shows

| Screen | Contents |
|---|---|
| **Source** | Pick any repository with `docs/plans`; recent choices are remembered and switchable at any time. |
| **Plans** | Every plan with progress, ready phases, locks, QA regime and health. Newest activity first; filter by status, ready, locked or repo. |
| **Route** | The plan as a transit map — phases are stations, dependencies are track, and each suggested session batch is a train threading the stations it carries. |
| **Departures** | The board: state, size, dependencies, gates, locks and QA for every phase. Every phase table — here, in Phases, in Overview and in Autopilot — shows the same columns, including who holds a phase and how much of their lease is left. |
| **Phase** | Goal, read-first, files, steps, exit criteria, verification, plus the phase's handoff, gate status, lock and boot prompt. |
| **Handoffs** | Every handoff with its front-matter contract, body and the boot prompts it generated. |
| **Analysis** | Critical path, bottleneck, best next phase, remaining weight and sessions, completion timeline, QA table, health issues. |
| **Overview** | Context, architecture, session budget, the phase-graph table, end-to-end verification and the plan's memory entry. |
| **Ready now** | Every ready phase across every plan, ranked by how much it unblocks, each with a copyable prompt. |
| **Statistics** | Portfolio totals, velocity, completions calendar, size mix, repos, skills, models, locks and every health issue. |
| **Autopilot** | Drive a plan unattended: one `claude -p` per phase, with the model, effort, skills and tool set chosen per run or per phase; the live session console; the approval queue; and the controls to pause, stop, retry, skip or run a single phase. A phase another session has **claimed** cannot be started — the console and the server both refuse, naming the holder, and the claim can be released from the row after a confirmation. A lapsed claim only warns. A **status header** carries a clock that advances on its own and an estimate of how much is left, and **What it is doing** shows the session's task list, its tool calls with durations and outcomes, and one lane per subagent. Every row expands to the phase's full detail. |
| **Agent** | Interactive `claude` sessions in the browser terminal — off unless started with `--allow-agent`. A launcher for model, effort, permission mode, the first prompt and extra skills; a **New plan with AI** wizard that boots the skill's plan mode from your brief and links the plan the moment it exists; ended sessions offer their `claude --resume` command. The argv is built server-side from allowlisted fields — the browser never supplies a command. Also the target of **recovery** sessions (a stuck phase handed to a session with a prompt the server composes) and **QA reviews** (a finished phase handed to a fresh session carrying the skill's own QA brief). |
| **Terminal** | A real shell in the browser — off unless the console was started with `--allow-terminal`. Token-handshaked WebSocket, durable sessions that survive a reload — and a browser close — a key bar for phone keyboards (including `⇧Tab`, claude's permission-mode cycle). |
| **Dashboard** | What needs you now, each warning next to the verb that answers it: continue or dismiss a halted run, release a stale claim (one or all — the owner is read off the lock file), mark the inbox read, repair a plan that will not parse, or hand any of them to an AI recovery session. Plus every live session across every plan. |
| **Notifications** | The inbox, and a switch per category that gates **every** delivery leg — no record, no live event, no `PHASE_CONSOLE_NOTIFY`, no push. Devices subscribed for push can only narrow what it allows. Pages mark their own records read as you read them. |
| **Settings** | Permission rules with a builder that names the forms people get wrong, the notification and push registers, restart, and shut down. |
| **Search** | Full text across all plans and handoffs, grouped by plan. |

The page updates itself: a watch on `docs/` pushes changes over server-sent events, so a handoff
written by an agent session appears without a reload. It is also an installable PWA: the app shell
is precached so it opens instantly (and offline it says so, rather than showing a stale board — live
data is never cached), and a new build is offered as an update toast, applied only when you accept.

## The autopilot

`--allow-run` lets the console spawn agent sessions. It is a separate flag from `--allow-writes` on
purpose: a write scaffolds a file, a run edits a repository for hours. `--no-converge` keeps the
convergence loop's automatic passes (boot, docs change, the periodic sweep, the minute after a stop)
off while leaving Recover & continue working — see *The convergence loop* below.

Each phase is one `claude -p` process, so "clear the session between phases" needs no implementing —
the process exits and takes its context with it. A phase advances only when three independent checks
agree: the plan's own verification commands pass, `validate.sh` still passes, and the board re-read
**from disk** says done. Nothing asks the session whether it succeeded.

**The outcome protocol.** A session can declare how it ended instead of leaving the runner to guess
from a clean exit: `scripts/phase-outcome.sh <slug> <N> <status>` writes one atomic JSON file to the
path the runner injects as `PE_OUTCOME_FILE`, and the runner reads, journals and consumes it on
exit. Five statuses — `complete` (advisory; the board still decides), `waiting-external` (the work
needs an external clock: a CI build, a PR auto-merge, a deploy window), `blocked` (with a
`lock:<slug>/<N>` watch ref it re-queues; otherwise the blocker statement decides — see the ladder
below), `needs-human` (parks the run for a person with the errand recorded, not counted as a
failure), and `partial` ("work remains, resume me": the session had to stop — budget, context —
without anything being wrong; the runner reads it as work in progress and continues the session
instead of nudging a closeout that may not do the work). Every prompt the runner sends
carries the unattended-session contract naming this — including the fact that `ScheduleWakeup`,
`Monitor` and backgrounded watchers do not survive a `-p` turn ending. A **Stop hook** enforces it,
belt-and-braces: a session about to end with neither a handoff on the board nor a declared outcome
is told exactly what to do instead (at most twice per session; fails open — the runner's own
exit-time check is the load-bearing layer, and the hook carries workflow, never safety).

**Waiting on external work.** A `waiting-external` outcome parks the phase as `waiting` — not a
failure, not settled: the lane, its scope grant and its lock are released so siblings run, and at
`parkedUntil` the runner **resumes the phase's own session** (`claude -p --resume`, context intact)
to verify and close out, or re-file the wait. When every startable phase is parked, the run itself
waits with the soonest clock (`waitUntil`) — restart-safe: a console reboot re-arms it exactly like
a usage-window sleep. Caps make the wait honest: 4 waits and 8 hours parked per phase, then a
`waiting-external-timeout` halt naming the watch refs.

**Rulings — what a session decided.** The same script's second shape,
`phase-outcome.sh <slug> <N> ruling --what … [--why …] [--kind ambiguity|deviation|deferral]
[--cost-if-wrong …]`, appends one NDJSON line to `$PE_RULINGS_FILE` (unsupervised:
`runs/<instance>/<slug>/rulings.ndjson`). A ruling is not an outcome and nothing acts on one — it
does not park a phase, climb the ladder or end a turn — which is what makes it safe to record every
judgement call the plan did not make for you. The console ingests the ledger into the run
(`run.rulings`, journal `phase.ruling`), serves it at `GET /api/run/:slug/rulings`, puts the phase's
own on its diagnosis, and raises one `fyi` inbox row per recent one; acknowledging appends a further
line rather than editing a file a live session may still be writing to.

**Liveness — is the lane actually working?** A wedged `Bash` call, a session reasoning in circles and
a session about to commit all read `running` with a spinner. Every live lane now exposes
`{lastOutputAt, lastToolUseAt, turnsSinceLastTool, commitsSinceStart, treeDirty, openTool?, stall?}`
on `GET /api/run/:slug`, and a 60-second ticker raises one of three signals against it: `silent` (no
output for `stallSilentMs`, naming the call open longest), `spinning` (`stallSpinTurns` turns with no
tool call) and `stalemate` (`stallStalemateAttempts` attempts that committed nothing and left a clean
tree). A phase inside its own §Verification is exempt — a build is silent and fine. One episode is
one card: only transitions are journalled (`phase.stall` / `phase.liveness`) and announced, under the
**`stalled`** category, on by default and deliberately not urgent. v1 is display, notification and
manual verbs (nudge, freeze, stop the lane); making it a ladder situation is the v2 path
([docs/loop.md](../docs/loop.md)).

**The ladder in the loop.** `interrupted` and `failed` records are not terminal any more. At the top
of every drive tick, after reconcile, the runner **classifies** each of them — and each phase whose
handoff exists but is not complete — against the board, the handoff, the lock and the working tree
(`runner/situation.ts`: `never-started`, `work-in-progress`, `done-unrecorded`, `verify-red`,
`blocked-declared:<sub>`, …), climbs one rung of the remediation ladder (`runner/ladder.ts`, the same
history and caps the healer uses) through its own vehicles, and boards the phase with the **brief**
the rung names: `fresh` (the engine prompt alone — a never-started phase), `resume` (the prompt plus
a RESUMING block: handoff status, uncommitted paths, last verification, last words), `unblock` (the
prompt plus the handoff's Outstanding text and "you MAY do the work; if the blocker is an operator's,
declare `needs-human` with the exact errand" — ONE bounded session), `continue` / `closeout` (the
phase's own session, `--resume`). A blocked handoff therefore no longer halts at once: a lock
sub-kind re-queues, `credential`/`gate` park with an **errand** immediately, `unknown` gets one unblock
session and then the errand. Exhaustion parks the phase with the errand — one named ask, journalled
`phase.errand` — and the run keeps driving whatever else is ready. Journal vocabulary:
`phase.situation` → `phase.rung` → `phase.brief` → `phase.start`, `phase.errand`,
`phase.ladder-deferred` (a rung remains that only the healer's agent can drive). The healer reaches
the same vehicle from outside the loop through `startRun({resumeRunId, reboard: [{phase, situation,
rung, brief}]})`. Opt-in is the run's own auto-recovery switch; a never-started phase re-boards fresh
regardless, because that is the run doing its job.

**The convergence loop.** Since 2.3.0 the machinery runs without anyone looking (`server/converge.ts`).
One pass per plan — `planConvergence` (pure) decides, `executeConvergence` acts, `ConvergeScheduler` is
the clock — runs **at boot** (after queued runs are re-adopted), **on a docs change** (trailing debounce
2 s), **every `convergeEveryMs`** (Settings ▸ Automation, default 5 min, floor 30 s), **a minute after
any stop** (the quiet minute the old auto-recovery timer kept; a change inside it does not shorten it),
and **on Recover & continue** (now, awaited, the pins off — it is the operator's press). What a pass
does, in order: release **lock debris** — a claim owned by `autopilot/<runId>` of a run nothing is
driving, expired or not, released as its own owner through `phase-lock.sh release` (`--git` never
passed) and journalled `run.lock-debris-released`; a person's claim is never debris; **relaunch** a run
the console's own restart stopped (`stoppedBy: 'system'`): lanes a restart killed re-board through
`startRun({resumeRunId, reboard})` hinted to **resume their own session** (`brief: continue`; a session
that cannot be resumed degrades to a fresh boot with the resume block), bounded by `MAX_BOOT_RESUMES` 3
per phase and journalled `phase.resume-at-boot` — with Settings ▸ Automation ▸ *Resume at boot* off the
run waits for a person with one errand naming exactly that; a lock-cap park re-arms when the lock it
waited out is gone (`phase.lock-cap-rearmed`; the live loop does the same at the top of every tick);
and a shutdown between phases simply continues. Then the **healer** (`maybeAutoRecover`: classify the
open phases, climb one rung, drive it through the runner) — once per evidence: a pass that healed
nothing remembers the evidence fingerprint and does not re-read it until something changes. What it
never touches: a run the **operator** paused or stopped (`stoppedBy: 'operator'` — Pause, Stop, an
escalated freeze; for records written before the field, any pause), a **resolved** run, a live one, a
run waiting on its own clock, a `finished` or `queued` one. `--no-converge` keeps the automatic
triggers off (a bare harness has them off by construction); the operator's press still converges. Every
pass that acts journals `run.converge` on the run it acted on. `POST /api/run/<slug>/recover` answers
`outcome: 'errand'` with the `Errand` body — what is needed and how to give it — wherever nothing
could be launched; there is no bare `needs-you` any more. A `done` record over a board that does not
read done is a health warning, `record-ahead-of-board`, never rewritten.

**The board is live, not per-lane.** The docs watcher pokes running loops, so a handoff written by a
manual session mid-run is seen NOW rather than when a lane settles; a reconcile pass at the top of
every drive tick closes any record the board has overtaken (`done`, noted "closed outside this run")
and dissolves halts anchored to them — it only ever closes records, never re-runs a failed phase.

**Recovery order.** Resolve first: before anything is launched, the board is re-read and reconciled
— a halt the board has moved past becomes `superseded` with nothing spawned. Then the session API:
for `no-handoff`, `verify-failed` and `waiting-external-timeout` halts with a resumable session,
auto-recovery resumes the phase's own session through the runner (settings, deny rules, hooks and
journal all apply; needs only `--allow-run`). The pty agent remains for plan-shaped repairs (an
unrunnable §Verification, a failing `validate.sh`) under `--allow-agent`, and as the manual
fallback. A recovery that finds nothing wrong records `no-defect` — the halt stands down without
inventing `done` — and a recovery finishing under a live loop hands its verdict to the loop instead
of being skipped.

**Cross-plan locks.** A foreign unexpired lock — another plan's run, a manual session, another
machine via the git-synced lock files — queues the phase behind the holder (named on the queue page
with its lease end) instead of parking it terminally. The queue wakes on the docs watcher (lock
files live under `docs/handoffs/**/.locks`), on a timer armed at the soonest blocking lease expiry,
and on the idle poll; past a 2-hour lock wait the phase parks honestly, naming the holder. While a
lane's session lives, the runner refreshes its lock every 10 minutes under the shared `PE_OWNER`
(same-owner `claim` extends the lease), so a 47-minute phase can never silently lose its 30-minute
claim; a foreign `--force` takeover is journalled and never fought.

The park and lock knobs are runner constants, deliberately not in `scripts/sizing.env` (F5
single-sources numbers both bash and TS read; bash never reads these): `WAIT_DEFAULT_MS` 30 min,
`WAIT_MAX_PER_PHASE` 4, `WAIT_BUDGET_MS` 8 h, `LOCK_WAIT_CAP_MS` 2 h, `LEASE_REFRESH_MS` 10 min —
all in `server/runner/runner.ts`.

**The run drives to plan completion.** The board is re-read after every phase, so work a finishing
phase unlocks starts itself — the queue only ever shows what can run *now*, and the **Waiting** tab
beside the session tabs shows the rest: each dependency-waiting phase with exactly what it waits on,
so phases 10 and 11 of an 11-phase plan never look abandoned while 7 and 9 run. The run ends when
the whole graph is done, or parks naming precisely what still needs a person. Pressing Start or
Continue also restores the consecutive-failure budget — an operator back in the loop is the same
signal a phase succeeding is.

**What a phase runs as** is resolved from three places, in this order: what you chose for this run,
then the plan's own `**Model:**` / `**Effort:**` bullets for that phase, then the run's defaults —
per field, so choosing a model does not discard an effort the plan asked for. The journal records
which source answered each one.

**Skills.** The console lists every skill a session could invoke — personal, this repository's, and
every installed plugin's — and appends the ones you pick to the boot prompt, per run or per phase.
The plan's own `Skills (every session)` line still comes from the engine and is shown as fixed.

**Talking to a running phase.** The session's stdin stays open, so a message is one more turn in the
same conversation rather than a reason to stop it:

```bash
btw "why did you skip the cache?"     # or the box under the session console
```

Two modes, because they are different acts. **Ask** is framed as out-of-band before it is sent, so an
answer does not become a change of direction. **Steer** is the opposite and says so: an instruction to
fold into the work — with the caveat that the plan's exit criteria and its verification commands still
decide whether the phase passes, so steering a phase past its gate is not a thing that can happen.
Each message carries a tag; the console shows it once, ticks it when the CLI echoes it back, and puts
the session's reply beside the question rather than losing it in an hour of build output.

**Watching a phase.** A `claude -p` process is opaque by default, and a scrolling transcript answers
"what has it said" rather than "what is it doing". So the run page also reads the same stream as
*state*: the session's **task list**, its **tool calls** with a duration and an ok/error outcome each
— paired by the CLI's own `tool_use` id, so a call still running is told from one that finished
instantly — and **one lane per subagent**, matched to the `Agent` call that started it rather than
folded into a single voice. All three are rebuilt from the stored transcript, so they survive a
reload the same way the console does.

**How much is left** is estimated from what the plan has already done: each phase carries a size,
each finished phase records how long it took, and the rate is an exponential moving average of
duration-per-weight (α 0.4) over every run of that plan — recency-weighted, because model and effort
change between phases. It is shown as a coarse range and never a countdown, the band widens when
there is less evidence, and it is absent entirely until a phase has actually finished. Guessing is
what it is for; pretending to know is not.

**Stopping a phase.** Two pauses, deliberately named apart. *Pause after this phase* waits for the
work in flight to finish and be verified. *Freeze now* stops **every** running session where it
stands (`SIGSTOP`) — instant, reversible, and it loses nothing, because each process is still there
holding its session. A freeze left longer than fifteen minutes converts itself into a checkpoint
instead: the child is asked to stop, its session id is written into the run, and Continue picks it
up with `--resume`. A stopped process holds its memory and a prompt cache that expires anyway, so an
overnight freeze is not the cheap option it looks like.

**Stopping one session.** With several phases in flight, the run-level verbs are a bigger hammer
than one misbehaving session calls for — so every session tab (and each lane on the Runs page)
carries its own **Freeze/Continue** and **Stop**. A per-session Freeze is the same `SIGSTOP`, scoped
to that lane; the run keeps its other sessions working and only reads `frozen` when nothing is left
running. A per-session Stop ends that session (SIGCONT first, then SIGTERM, then the 15-second
SIGKILL backstop), records the phase **interrupted** with its session id kept — Retry can resume it
— and hands the loop straight back to scheduling: the rest of the run carries on, and phases that
depended on the stopped one wait honestly. A queued phase's Stop simply takes it out of the
admission line before anything spawns. None of it touches the failure budget: an operator's stop is
neither a failure nor an endorsement.

**Being told.** Four paths, in increasing order of how far they reach — and one of them keeps a copy.

The **inbox** (`#/notifications`) is the copy. Every announcement is written to an append-only log
before any of it is delivered, so it is complete by construction: an event that arrived with the
phone asleep, no tab open and no device subscribed is still there in the morning. Grouped by day,
unread first, filterable by category, and each row opens the thing it was about. It survives a
restart, holds 500 records or 30 days, and is cleared only when you say so. Every row also carries
what became of it per device — `sent`, `throttled`, `failed`, `gone` — because a push that quietly
went nowhere is otherwise indistinguishable from one that worked.

*In this tab* is the Notification API: free, instant, and gone with the tab. *On this device* is a
push subscription — a service worker and a VAPID keypair, so the notification arrives with the
console closed and the phone locked. Both are in **Notifications → Settings**, per device, across
twelve categories: permission needed, a phase needs you, run halted, run parked or waiting, phase
finished or failed, plan finished, work became ready, plans changed on disk, a session ended,
console problems, usage limits, usage climbing. Only the first three are sent urgent.
A **Send a test** button goes out through the real push service and back, so it proves the chain
rather than the last hop. An approval notification carries **Allow** and **Deny** as notification
actions, so answering from a lock screen is one tap.

`PHASE_CONSOLE_NOTIFY=<command>` covers what neither can: a machine with no browser in the picture at
all. It is run as `cmd "<title>" "<body>"`, and is an environment variable rather than a setting
because it runs a command on this machine. Under the background agent it has to be in the plist /
unit — a variable exported in your shell does not reach the job the supervisor starts at login,
which is the one running while you are asleep — so `deploy/agent.sh install --notify '<command>'`
bakes it in.

Every destination is decided by one function (`routeFor`), used by the SSE announce, the push
payload, the service worker and the inbox row alike, and a test walks the catalogue against the
client's own router. Before it there were two hand-written URLs and both named a tab that does not
exist, so every approval notification for the life of the feature opened the wrong page.

Payloads are encrypted to the subscribing browser ([RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291)),
so a push service relays a notification about your plans without being able to read one. As with the
rest of this console, there is nothing to install — `node:crypto` has every primitive it needs.

**What it will not do.** `permissions.deny` is handed to every session at CLI scope and is the layer
that holds with this console dead — measured, not assumed. The `ask` list goes through an HTTP hook
that **fails open**, so it carries workflow and never safety. Settings shows both, and says which is
which.

### Permissions: how much a run may do

Three profiles, chosen when a run starts and changeable while it is running:

| Profile | Ask list | Child argv | Use it when |
|---|---|---|---|
| **Guarded** (default) | in force — commits, installs, merges raise a card | `--permission-mode acceptEdits` | you are around to answer |
| **Trusted** | emptied | `--permission-mode acceptEdits` | an overnight run on work you trust |
| **Bypass** | emptied | `--permission-mode bypassPermissions` | the CLI's own prompting is in the way too |

**`deny` is identical in all three.** A profile only moves the ask list — "identical" meaning
whatever the operator's edited wall currently holds, struck rules and additions included. That holds
under Bypass too — the CLI's own description of `bypassPermissions` is that it "auto-approves every
tool call *except explicit deny rules*".

**Bypass needs a disclaimer you can only accept interactively.** Read out of the CLI: given
`--permission-mode bypassPermissions` without it, Claude Code does not error and does not honour the
flag — it silently downgrades to `default`, and `default` in `-p` mode means prompting a terminal
that is not there, i.e. refusing every edit. So on a machine where nobody ever accepted it, Bypass
produces a run that can do **less** than Guarded, for no visible reason. Accept it once in a normal
`claude` session, or use Trusted. The console watches for the CLI's own downgrade line and surfaces
it rather than letting the phase quietly fail.

Switching mid-run is journaled as `run.permission-profile`
with who did it, takes effect at the hook on the *next tool call*, and reaches the child's argv at the
next phase — the running child cannot reload its own settings, and the console says so rather than
implying otherwise. A run on anything but Guarded carries a banner for as long as it is in force.

### Writing a rule from the card that interrupted you

An approval offers **Always for this plan** and **Always everywhere**, each showing the exact rule
before it writes it. That rule is derived from the ask rule that actually stopped the call, so
accepting it cancels precisely what interrupted — and it is written *before* the card is settled, so
the session's next call is already classified under it.

- Plan-scoped rules live in `~/.config/phase-console/plans/<slug>.json`; global ones in
  `~/.config/phase-console/autopilot.json`. Both are additive over the shipped defaults.
- Evaluation is **deny → an allow you wrote → ask → allow**, first match winning, specificity
  irrelevant. The one deviation from Claude Code's own order is deliberate: a plain allow rule can
  never cancel an ask rule, so "Always allow this" would otherwise write a rule and change nothing.
- Every write is journaled as `policy.edited` against the live run, with the author and the scope,
  and is removable from **Settings → Permissions** with the × on its chip. Shipped defaults are
  removable the same way — struck by name at the chosen scope (so an upgrade that ships a new
  default still applies it), listed struck-through beneath the chips with a ↩ to bring one back,
  and each part has a **Restore defaults** button that returns it to stock in one act. That
  includes the shipped **deny** list: striking one of its rules is the widest edit the page can
  make — the wall moves for every future run, the CLI-side settings each child runs under
  included, with this console dead included — so that one strike, and only that one, asks you to
  confirm first. Your own deny additions stay one-tap removable as always.
- **This widens as well as tightens**, which reverses the console's earlier rule that a browser could
  only ever make a run more careful. What that produced in practice was ten `git commit` cards in one
  run and a person tapping Allow without reading — the failure the strict version existed to prevent,
  by a different road.

### Which rules this console can actually enforce

The PreToolUse hook only fires for `Bash`, `Write`, `Edit`, `NotebookEdit`, `WebFetch` and
`WebSearch`. Rules about anything else — `Read`, `Agent`, `Cd`, `mcp__*` — are real and the CLI
enforces them, but nothing here will show you one being hit, and Settings labels them `cli-only`
rather than implying otherwise. The supported forms are the documented taxonomy: bare tool,
command prefix (`Bash(git commit:*)`), command glob (`Bash(npm run test *)`), one parameter
(`Agent(model:opus)`), paths (`Read(~/.ssh/**)`), domains (`WebFetch(domain:*.example.com)`), MCP,
agent types and `Cd`.

The edges are surfaced in the UI because each has cost someone an afternoon:

- `Bash(ls:*)` is `Bash(ls *)` — it does **not** match `lsof`. `ls *` and `ls*` are different rules.
- Wrappers are seen through — `timeout time nice nohup stdbuf command builtin noglob` and bare
  `xargs` — but **not** `npx`, `docker exec` or `devbox run`.
- `watch`, `setsid`, `flock` and `find -exec` never auto-approve: what they run cannot be seen from
  outside, so they get a card.
- Only `Read(…)` and `Edit(…)` path rules are consulted; `Write(…)`, `NotebookEdit(…)` and `Glob(…)`
  paths are ignored. `Bash(command:rm *)` parses and does nothing. Settings lists any such rule you
  have written under **These parse and do nothing**.

### When nobody answers

A tool card waits **an hour**, not ten minutes. At ten, a real overnight run had a commit refused
because everyone was asleep — the worst outcome available, since the work was done and the session
was told "no" for a reason that was really "you were away". The hook is still answered before its own
timeout (silence fails open), but a timeout now **parks the run** instead of letting the session treat
the refusal as a verdict about the work: `run.parked`, failure counter untouched, phase retryable the
moment the card is answered.

The runner will also not execute a verification command that reaches outside the working tree unless
it can be shown read-only — `curl -X POST`, `ssh box 'systemctl restart …'` and `psql -c 'DELETE …'`
all go to a person with the reason attached, while `docker ps` and `psql -c 'SELECT …'` still run.

### What the healer reads first: the situation

Since 2.3.0 the unattended healer (and the phase page's *Why is this not done?* panel) no longer
picks a remedy from the halt kind alone. Every open phase is **classified** from evidence that
already exists — the board line, the handoff's status and Outstanding text, the run's record and
halt, the lock, the working tree of the repos the phase names, the gate, QA, MCP and health — into
one **situation** (`viewer/shared/situation-model.js`: `never-started`, `work-in-progress`,
`done-unrecorded`, `verify-red`, `blocked-declared:<lock|credential|gate|external|unknown>`,
`waiting-external`, `gated-manual`, `plan-broken`, `mcp-unavailable`,
`resource-wall:<usage|auth|budget|model>`, `foreign-live`, `foreign-stale`, `qa-pending`,
`qa-failed`, `superseded`, `unknown`). A **remediation ladder** (`server/runner/ladder.ts`) then
names the next rung for that situation — never the same rung twice on one phase, bounded per
phase / run / day by attempts **and dollars** (Settings ▸ Automation: `ladderPerPhaseRungs` 3,
`ladderPerPhaseUsd` 100, `ladderPerRunRungs` 10, `ladderPerRunUsd` 400, `ladderPerDayUsd` 600) —
and when the ladder is exhausted the phase carries an **Errand**: what is needed, how to give it,
what was already tried. The journal records `phase.situation`, `phase.rung` and `phase.errand`.
The rung table itself is `viewer/shared/ladder-model.js` — imported by the server's ladder, the
client and the tests by identity — so what the autopilot climbs is what every **Ways forward** group
shows: the situation chip, the rungs tried with how each ended, the rung it tries next, and, once
the ladder is spent, the one errand card (what is needed, how to give it, what was tried). The
dashboard's **Waiting on you** lists only errands, permission cards and sign-ins — a halted run
with no errand is the loop's to climb, not yours to stare at; the run page's banner lists a parked
run's errands in full; the Pulse carries a **Converge** line per plan with the loop's last pass
("re-boarded P12 (Never started → Re-board fresh) · released a stale claim on P3") from
`GET /api/converge` and the `run:converge` event; and Settings ▸ Automation's ladder card edits the
caps, the sweep, the four toggles, the one budget raise and the MCP park clock. The whole
specification — situations, rungs, convergence triggers, presence, what is still a person's — is
`docs/loop.md`.

## Sessions, and the two the console starts for you

Agent sessions and shells are processes on this machine, not objects in a tab. Closing the browser
detaches the socket and leaves the work running; reopening reattaches with scrollback. Nothing is
reaped for being idle — a session ends when you end it, or when the console goes down — and the cap
of 8 counts live processes, so ended ones never crowd out a new one. A session that has exited stays
in the list with its status and its `claude --resume <id>` until you dismiss it, or for 24 hours.

**Session presence — the hook.** The console also knows about sessions it did not start. A
user-scope Claude Code hook (`scripts/session-hook.sh`, installed from Settings ▸ Session presence or
`phase-console install-hooks` / `uninstall-hooks` / `hooks-status`; it edits `~/.claude/settings.json`
by merging three entries and never touches another key) reports every Claude session on the machine
whose working directory a console owns — SessionStart, each finished turn, SessionEnd — to that
console (`POST /hooks/session`, loopback only), or into the instance's inbox when it is down. The
registry (`GET /api/sessions/registry`, and the Pulse) lists them with a three-valued presence:
*live*, *ended*, *unknown*. A phase lock that names its session (`phase-lock.sh --session`, or the
`PE_SESSION_ID` the runner exports) becomes debris the moment its session ends — the scheduler admits
the phase queued behind it and the convergence loop releases the file — instead of at the end of its
lease; a live session's lock is a queue to wait in; a lock nobody reports keeps lease rules. And a
`phase-outcome.sh` run in a session nobody supervises (no `PE_OUTCOME_FILE`) lands in
`runs/<instance>/<slug>/outcomes/`, where the console picks it up: a `waiting-external` parks the
phase and resumes that very session at the window, a `partial` boards it again with a resume. Off by
default — installing the hook is the operator's choice.

Two kinds are composed for you rather than typed:

**Recovery.** Each way a run comes to rest has a session that answers it — a failed verification, a
phase that did the work but wrote no handoff, an interrupted run, a run stopped at a sign-in, a stale
claim, a plan that will not parse. **The server composes the prompt**, reading the board, the run,
the phase diagnosis, the lock and the health issues itself; the browser names only the target, which
is both the security property and the honest one. It refuses while the autopilot is driving, refuses
a second recovery for the same phase (linking to the live one instead), and on exit re-reads the
board from disk to say whether the phase actually went green.

**Review.** Any finished phase can be handed to a fresh session for QA. The brief is the skill's own
`phase-graph.sh --qa-prompt N`, embedded verbatim, plus what the engine cannot know: the handoff the
phase wrote, its key files, the commits that touched it, and that phase's exit criteria and
verification quoted rather than summarised. It will not resume the session that built the phase, run
while the autopilot drives, run while a session is still building that phase, or start twice for one
phase. **The session records the verdict with `qa-record.sh`; the console only reads it back** —
`test-status.md` is re-read on exit and compared with a snapshot taken at launch, so a session that
ended without recording one is reported as exactly that.

Both ride `POST /api/terminal` behind `--allow-agent`; neither adds a route. `permissionProfile`
(`guarded` | `bypass`) is accepted **only** with a review and refused on every other agent session.
Turning QA on for a plan (`POST /api/plans/:slug/qa-mode`, `--allow-writes`) goes through the
skill's own `--qa` path, which waives the already-finished phases rather than gating them.

## The rule it follows

`phase-graph.sh` is the only source of truth for **done / ready / waiting**, session batches, boot
prompts, QA regime and lint. The console shells out to the skill's own scripts for all of that and
never recomputes it. JavaScript parsing covers only what the scripts do not expose — prose sections,
phase detail, handoff bodies — plus analysis they do not provide (critical path, unblock value,
velocity). `test/engine-parity.test.ts` re-derives every plan's board from the JS parse and asserts
it matches the engine, so the two readings cannot drift apart unnoticed.

## Writes

Off by default. With `--allow-writes` the console can run six scripts, each behind a dialog (or, for
gates, a press-twice confirm) that shows the exact command first:

| Action | Script |
|---|---|
| Scaffold a plan | `new-plan.sh` |
| Scaffold or repair a handoff | `new-handoff.sh` |
| Record a QA result | `qa-record.sh` |
| Approve or revoke a phase gate | `gate-approve.sh` — the phase page's **Gate card**; an approval clears a gate of any kind, and can continue a run the gate parked |
| Claim or release a phase | `phase-lock.sh` |
| Turn QA on for a plan | `new-handoff.sh … --qa` (it backfills finished phases as waived) |
| Close or reopen a plan | `close-plan.sh` (a status and a one-line reason; reopening needs neither) |

`--git` is never passed, so the console never commits or pushes — that stays a deliberate act in a
terminal. Editing plan or handoff bodies is deliberately not offered; agents write those.

The server binds to `127.0.0.1`, and every write requires an `x-phase-console` header plus a
same-origin `Origin`, which a browser will not send cross-origin without a CORS preflight the server
never answers.

## Claude accounts and usage limits

The chrome carries usage meters on every page — the 5-hour session window, the weekly allowance,
and every per-model window the usage endpoint reports (Opus, Fable, … — rendered by key, so a
window that ships tomorrow appears tomorrow), per account, with reset countdowns. The compact bars
read the **worst window across every account**, naming the account supplying the number — a second
account walking into its wall must never hide behind a green machine-login meter — and the dialog
behind them holds the per-account truth. The numbers are the same ones `/usage` shows (polled
gently, cached, served stale with their age attached when the endpoint is unreachable), and they
work with no flag at all.

`--allow-accounts` turns on **registration**: each console instance keeps its own account registry.
Sign a second Claude account in (a managed `CLAUDE_CONFIG_DIR` profile — the console opens a
terminal on `claude auth login`, then reads back the email), or paste a long-lived token from
`claude setup-token` and name it. Secrets go to the keychain (or a 0600 file), never into
`accounts.json`, never to the browser, and the console never writes the CLI's own credentials.
Accounts can be **renamed** (the display name only — the id underneath is a journal key and never
changes) and **removed**: removal takes this console's registration, the profile directory and, on
macOS, the CLI's hashed keychain item that existed only for that directory — never the machine
login's own entry — and refuses while a live run is paying as that account.

**Expired logins announce themselves.** Every account's credential is watched with its meters; a
login that goes from good to expired or signed out (after the CLI's own refresh has been tried)
raises a *Sign in again* notification, badges the account in Settings and the meters, and the run
page's sign-in card names the right account with the right command — a run pinned to a profile is
preflighted **as that profile**, so an expired one refuses before spending a session rather than
burning one per phase discovering it.

Every launch surface — the run form, the phase launcher, the recovery and QA dialogs, the agent
launcher — then offers an **Account** choice (including `auto`, most 5-hour headroom) and, for
runs, an **on-limit policy**:

| Policy | At the shared usage window (session/weekly) |
|---|---|
| `switch` *(the dialogs' default)* | Checkpoint the session, continue immediately under the account with the most headroom — same session when its transcript can be carried into that account's config dir, a fresh boot prompt when it cannot. With one account it degrades to `wait`. |
| `wait` *(the on-disk default)* | Sleep to the reset and resume by itself — including across a console restart, which re-arms the clock. |
| `pause` | Checkpoint and stop for you, with the reset time on the banner. |

A model-specific limit (Opus, Fable, …) keeps its own path: the run switches **model**, not
account, because those windows are per-model — and the wall is filed under its own bucket
(`seven_day_opus`, `seven_day_fable`, …), so `auto` skips that account only for runs of that model
and still sends a Sonnet phase there. Mid-run, **Switch account** on the run card acts immediately
— the picker lists **every** account, the current one marked — a live session is checkpointed (its
session id kept) and re-attempted under the other login; the scheduler throttles only the limited
account, so runs paying with a different one keep flowing. Everything is journalled
(`run.account-switch`, `phase.transcript-port`); the `limits` notification category announces every
wall that is actually hit and every login that needs signing in again, and the 80/95% early warning
is its own off-by-default category, *Usage climbing*.

## MCP servers

Sessions can call tools you attach: a browser, an issue tracker, a documentation server. The
console's contribution is narrow — Claude Code connects to MCP servers perfectly well on its own.
What it cannot do is tell you, before an unattended run spends an hour, that the server the plan
chose was never signed in.

A plan states what it needs (`**MCP servers (every session):**` in §Session budget, and a per-phase
`- **MCP:**` bullet, unioned). Those are **registry ids** — what the phase needs, never how to reach
it, because the how is per-machine. The registry lives under the instance's state dir, per instance
like the accounts one and for the same reason: a server that belongs to one project is exactly the
wrong thing to hand another.

Before a phase boards, the console probes the exact set it would run with — a one-turn
`claude -p --strict-mcp-config --mcp-config <set>` whose `system/init` reports each server's real
status before any model call. That matters because an unattended session cannot fix a wall itself:
there is no `/mcp` panel in `-p`, and the CLI reports the missing tools to the *model*, which then
improvises around them.

**What it does about a wall is a policy, and the default is to carry on.** The phase boards with the
servers that answered, its prompt names the ones it did not get and instructs it neither to
improvise a substitute nor to treat them as a blocker — do the work that does not depend on them,
and record the rest under **Outstanding** as an operator errand — and you are told once per run per
server. Set **Settings ▸ Automation → When an MCP server is unavailable** to *Park the phase* for the
old behaviour, per run in the launch dialog, or per phase in the run's phase matrix; a plan can
demand it for itself with `**MCP policy:** require`, which outranks the run-level choice because a
plan is a versioned statement about the work rather than one launch's convenience.

The default moved because the park was answering for the phase that genuinely needs its server and
firing for every phase that merely had one attached. `parked` is a settled status, so a run whose
ready phases all park has no candidates left and halts: one signed-out server stopped an eleven-phase
plan that named no MCP servers of its own, 0 phases done. A phase that does park now names both
doors — sign the server in, or **Continue without these servers**, one button on the halt card — and
signing a server in still requeues everything parked on it, including on a run that has already
stopped.

The spawn always pairs `--mcp-config` with `--strict-mcp-config`, so the resolved set is the whole
set — without it the CLI would union in whatever `~/.claude.json` and the project's `.mcp.json`
happen to hold, and the run would be talking to servers nobody chose for it.

Three kinds of credential, and the console holds one. **OAuth** goes through
`claude mcp login <id> --no-browser` in a terminal, and the token stays in the CLI's own store — a
second writer is how two processes corrupt one login. **A header token** is ours: keychain on macOS,
a 0600 file elsewhere, never in `servers.json`, never in the browser. **`${VAR}`** is not a secret
but the name of one, passed through unexpanded so the CLI resolves it in the child's environment. A
URL carrying its own credential is refused on add.

Every probe fingerprints the tools a server advertised. A change raises an alert rather than being
absorbed: a server whose tool *descriptions* change can change what your sessions are instructed to
do, which is the documented supply-chain attack against MCP. Tools marked `requiresUserInteraction`
are flagged too — an unattended run can never approve one.

MCP calls never reach the console's PreToolUse hook, so `mcp__server` rules land in the settings
file's `permissions.deny` and hold whether or not this console is running.

`--allow-mcp` gates registration. Reading the registry, the connection statuses and the catalog does
not — seeing what your own sessions connect to is display, not capability.

## From a phone

The point of an unattended run is that you stop watching it, and the point of the approval queue is
that a run can ask you something while you are not watching. That only works if the console can be
reached from wherever you are.

It still binds to `127.0.0.1`. What changes is that something in front of that socket authenticates
the caller and says who they are. [Tailscale Serve][serve] is the case this was written for: it
terminates TLS, checks the caller against your private network, and forwards to loopback with their
login in `Tailscale-User-Login`.

```bash
# the console: unchanged bind, plus who may arrive through the proxy
./start --root ~/code/your-repo --allow-writes --allow-run \
        --remote your-machine.your-tailnet.ts.net \
        --remote-user you@example.com

# the proxy: HTTPS on the private network, forwarding to loopback
tailscale serve --bg --https=443 http://127.0.0.1:4123
```

| Flag | Meaning |
|---|---|
| `--remote <host>` | Also answer to this hostname, fronted by an authenticating proxy. Repeatable. Turns on strict `Host` checking. |
| `--remote-user <login>` | A login allowed to arrive that way. Repeatable, or `PHASE_CONSOLE_REMOTE_USERS`. Required by `--remote`; without one the console refuses to start. |

Naming a hostname means exactly two kinds of request are served: a loopback `Host` with no identity
header (you, at this machine) and the named hostname with an allowlisted login (you, through the
proxy). Everything else is refused — including a proxied request asking for a loopback `Host`, which
is how someone on the network would otherwise skip the identity check, and any unknown `Host`, which
is what a DNS-rebinding page arrives with. With no `--remote` at all, nothing here applies and every
request is treated exactly as it was before.

**The identity header is only worth anything because the app stays on loopback.** If it listened on a
network interface, anyone could send the header themselves. `--remote` deliberately does not widen
`--host`; the [Tailscale documentation][serve] makes the same point.

**The full setup** — the two admin-console switches, the phone, the Home Screen install that iOS
notifications require, out-of-band alerts, access rules and a troubleshooting table — is in
[docs/phone.md](../docs/phone.md).

[serve]: https://tailscale.com/docs/features/tailscale-serve

## Development

```bash
npm ci                        # once — the toolchain and the client's dependencies
npm run dev                   # Vite on :5173, proxying the live console on :4123
                              #   (PHASE_CONSOLE_ORIGIN=http://127.0.0.1:4199 targets another)
npm test                      # server + shared contracts (node --test — needs no build)
PHASE_CONSOLE_TEST_ROOT=~/code/your-repo npm test    # + integration & engine parity
npm run test:client           # the client suite (Vitest + jsdom)
npm run typecheck:client      # two programs: the app (DOM libs) and the worker (WebWorker libs)
npm run lint:client           # ESLint over client/src + shared (typescript-eslint, react-hooks)
npm run format                # Prettier over the same files (format:check is what CI runs)
npm run verify:dist           # build into client/.dist-verify + the build gate — the live dist untouched
npm run build                 # emit client/dist and stamp .build-rev with the commit
npm run check:dist            # the build gate: budget, precache sanity, sw.js at the root
```

`verify:dist` exists because `client/dist` is what a running console serves: a build into it cuts the
live console over on the next request. `PC_DIST_DIR` (relative to `client/`, or absolute) is the one
knob — `vite.config.ts`, `stamp-build.mjs` and `check-dist.mjs` all read it; the server never does — and
`verify:dist` sets it to a scratch directory, runs the same gate, and cleans up (`--keep` to look).
`typescript` is pinned to the 6.x line on purpose: typescript-eslint parses through the TypeScript JS
compiler API, which the native 7.x package does not ship.

The node suite passes without a build on purpose — a fresh clone must be able to verify the server
before it has ever built the client (`test/static.test.ts` holds the not-built answers, including
the `/sw.js` fallback that keeps push subscriptions alive while `dist` is absent). The integration
tests skip unless `PHASE_CONSOLE_TEST_ROOT` points at a real plan library.

```
server/   index.ts (http) · service.ts (the model) · engine.ts (script wrapper) · store.ts (files)
          parse/ (front matter, plan, handoff, folder artefacts) · analysis/ (graph, stats)
          search.ts · git.ts · memory.ts · watch.ts · writes.ts · api/routes.ts
          terminal.ts (pty sessions + the WS upgrade) · runner/ (the autopilot)
          notifications.ts (the durable inbox) · push/ (register, catalogue + routeFor, RFC 8291)
          log.ts (structured log + exit record) · fallback-sw.js (what /sw.js serves un-built)
          lifecycle.ts (degraded state, ordered shutdown, supervisor detection)
client/   src/ (the React app: shell/ · views/ · components/ · lib/ · styles/ · sw.ts)
          public/ (icons, manifest) → dist/ (built output + .build-rev — gitignored)
shared/   routes.js · route-meta.js · console-model.js · phase-model.js · status-vocab.js · sw-push.js
          — dependency-free ESM, imported by the Node tests and the client alike
scripts/  check-dist.mjs (build gate) · verify-dist.mjs (the gate in a scratch build) · stamp-build.mjs · check-stamp.mjs
deploy/   agent.sh (launchd/systemd install/update/uninstall/status/restart/log)
```

Fonts are IBM Plex Sans (one variable file), IBM Plex Sans Condensed and IBM Plex Mono (SIL Open Font License), four
vendored woff2 files bundled by the build — never the `@fontsource` index CSS, which would precache every subset.
