# Phase Console

**English** · [فارسی](README.fa.md)

A local web console for phased execution: browse plans, phases and handoffs, see live status,
copy the boot prompt for any ready phase, and read statistics across the whole plan library.

## Start it

```bash
cd viewer && npm ci && npm run build && cd ..   # once per machine, and after an update
./start                                         # from the skill directory — opens your browser
```

The server is plain Node (22.6+, which runs TypeScript directly — nothing to compile there). The
client is **built output**: a Vite/React app whose `client/dist` is gitignored, so every machine
builds its own copy once. Skip the build and the console still answers — with a page naming the two
commands and the exact directory — and `npm start` warns when the built client is older than the
code. Nothing ever builds implicitly: what serves is always what you last deliberately built. Once
built, it works offline and installs to a phone's home screen.

The first screen asks which directory to read — any repository containing `docs/plans`. It remembers
the ones you pick, and you can switch at any time from the **Source** panel in the left rail or from
**Settings → Source**. To skip the picker, name the directory up front:

```bash
./start ~/code/your-repo      # open this plan library straight away
./start --allow-writes        # also enable the guarded write verbs
./start --port 8080 --no-open # different port, don't open a browser
```

## Keep it running

A foreground console dies with its terminal, with a logout, and with any crash.
Install it as a launchd agent instead and it starts at login and comes back on its own:

```bash
./start --install-agent --root ~/code/your-repo
./start --agent-status      # is it up, and as which pid
./start --agent-log -f      # follow the structured log
./start --agent-restart
./start --agent-update      # after a git pull: npm ci + npm run build, then restart
./start --uninstall-agent
```

`--install-agent` and `--agent-update` build the client as part of the job; the launchd boot path
never builds, so a restart serves exactly what was verified and a crash loop cannot spend its
throttle interval rebuilding.

It also tries not to fall over in the first place. An unhandled fault, a file watch that
errors, a browser that vanishes mid-stream — each is recorded as **degraded** state and
served through `/api/state` rather than ending the process. The file watch checks itself
every minute and rebuilds if it has gone deaf, because a frozen board looks exactly like a
working one. Every exit writes down its reason to
`~/.local/state/phase-console/console.log`, and a run that wrote none is reported as a
crash the next time the console starts — so "it just stopped" is a question the log can
answer.

## What it shows

| Screen | Contents |
|---|---|
| **Source** | Pick any repository with `docs/plans`; recent choices are remembered and switchable at any time. |
| **Plans** | Every plan with progress, ready phases, locks, QA regime and health. Newest activity first; filter by status, ready, locked or repo. |
| **Route** | The plan as a transit map — phases are stations, dependencies are track, and each suggested session batch is a train threading the stations it carries. |
| **Departures** | The board: state, size, dependencies, gates, locks and QA for every phase. |
| **Phase** | Goal, read-first, files, steps, exit criteria, verification, plus the phase's handoff, gate status, lock and boot prompt. |
| **Handoffs** | Every handoff with its front-matter contract, body and the boot prompts it generated. |
| **Analysis** | Critical path, bottleneck, best next phase, remaining weight and sessions, completion timeline, QA table, health issues. |
| **Overview** | Context, architecture, session budget, the phase-graph table, end-to-end verification and the plan's memory entry. |
| **Ready now** | Every ready phase across every plan, ranked by how much it unblocks, each with a copyable prompt. |
| **Statistics** | Portfolio totals, velocity, completions calendar, size mix, repos, skills, models, locks and every health issue. |
| **Autopilot** | Drive a plan unattended: one `claude -p` per phase, with the model, effort, skills and tool set chosen per run or per phase; the live session console; the approval queue; and the controls to pause, stop, retry, skip or run a single phase. A **status header** carries a clock that advances on its own and an estimate of how much is left, and **What it is doing** shows the session's task list, its tool calls with durations and outcomes, and one lane per subagent. |
| **Agent** | Interactive `claude` sessions in the browser terminal — off unless started with `--allow-agent`. A launcher for model, effort, permission mode, the first prompt and extra skills; a **New plan with AI** wizard that boots the skill's plan mode from your brief and links the plan the moment it exists; ended sessions offer their `claude --resume` command. The argv is built server-side from allowlisted fields — the browser never supplies a command. |
| **Terminal** | A real shell in the browser — off unless the console was started with `--allow-terminal`. Token-handshaked WebSocket, persistent sessions that survive a reload, a key bar for phone keyboards (including `⇧Tab`, claude's permission-mode cycle). |
| **Search** | Full text across all plans and handoffs, grouped by plan. |

The page updates itself: a watch on `docs/` pushes changes over server-sent events, so a handoff
written by an agent session appears without a reload. It is also an installable PWA: the app shell
is precached so it opens instantly (and offline it says so, rather than showing a stale board — live
data is never cached), and a new build is offered as an update toast, applied only when you accept.

## The autopilot

`--allow-run` lets the console spawn agent sessions. It is a separate flag from `--allow-writes` on
purpose: a write scaffolds a file, a run edits a repository for hours.

Each phase is one `claude -p` process, so "clear the session between phases" needs no implementing —
the process exits and takes its context with it. A phase advances only when three independent checks
agree: the plan's own verification commands pass, `validate.sh` still passes, and the board re-read
**from disk** says done. Nothing asks the session whether it succeeded.

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
work in flight to finish and be verified. *Freeze now* stops the session where it stands (`SIGSTOP`)
— instant, reversible, and it loses nothing, because the process is still there holding its session.
A freeze left longer than fifteen minutes converts itself into a checkpoint instead: the child is
asked to stop, its session id is written into the run, and Continue picks it up with `--resume`. A
stopped process holds its memory and a prompt cache that expires anyway, so an overnight freeze is
not the cheap option it looks like.

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
nine categories: permission needed, a phase needs you, halted, parked, phase finished, plan
finished, work became ready, plans changed, console problems. Only the first three are sent urgent.
A **Send a test** button goes out through the real push service and back, so it proves the chain
rather than the last hop. An approval notification carries **Allow** and **Deny** as notification
actions, so answering from a lock screen is one tap.

`PHASE_CONSOLE_NOTIFY=<command>` covers what neither can: a machine with no browser in the picture at
all. It is run as `cmd "<title>" "<body>"`, and is an environment variable rather than a setting
because it runs a command on this machine. Under launchd it has to be in the plist — a variable
exported in your shell does not reach the job launchd starts at login, which is the one running
while you are asleep — so `deploy/agent.sh install --notify '<command>'` bakes it in.

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

**`deny` is identical in all three.** A profile only moves the ask list; the wall is not a preference,
which is the whole reason it can be trusted. That holds under Bypass too — the CLI's own description
of `bypassPermissions` is that it "auto-approves every tool call *except explicit deny rules*".

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
  and is removable from **Settings → Permissions** with the × on its chip. Shipped defaults have no
  line to delete and are not removable from there.
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

## The rule it follows

`phase-graph.sh` is the only source of truth for **done / ready / waiting**, session batches, boot
prompts, QA regime and lint. The console shells out to the skill's own scripts for all of that and
never recomputes it. JavaScript parsing covers only what the scripts do not expose — prose sections,
phase detail, handoff bodies — plus analysis they do not provide (critical path, unblock value,
velocity). `test/engine-parity.test.ts` re-derives every plan's board from the JS parse and asserts
it matches the engine, so the two readings cannot drift apart unnoticed.

## Writes

Off by default. With `--allow-writes` the console can run four scripts, each behind a dialog that
shows the exact command first:

| Action | Script |
|---|---|
| Scaffold a plan | `new-plan.sh` |
| Scaffold or repair a handoff | `new-handoff.sh` |
| Record a QA result | `qa-record.sh` |
| Claim or release a phase | `phase-lock.sh` |

`--git` is never passed, so the console never commits or pushes — that stays a deliberate act in a
terminal. Editing plan or handoff bodies is deliberately not offered; agents write those.

The server binds to `127.0.0.1`, and every write requires an `x-phase-console` header plus a
same-origin `Origin`, which a browser will not send cross-origin without a CORS preflight the server
never answers.

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
[the main README](../README.md#-reaching-it-from-your-phone).

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
npm run build                 # emit client/dist and stamp .build-rev with the commit
npm run check:dist            # the build gate: budget, precache sanity, sw.js at the root
```

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
shared/   routes.js · route-meta.js · console-model.js · phase-model.js · sw-push.js
          — dependency-free ESM, imported by the Node tests and the client alike
scripts/  check-dist.mjs (build gate) · stamp-build.mjs · check-stamp.mjs
deploy/   agent.sh (launchd install/update/uninstall/status/restart/log)
```

Fonts are Archivo Narrow, Public Sans and JetBrains Mono (SIL Open Font License), bundled by the build.
