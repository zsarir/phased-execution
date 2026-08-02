# Phase Console

**English** · [فارسی](README.fa.md)

A local web console for phased execution: browse plans, phases and handoffs, see live status,
copy the boot prompt for any ready phase, and read statistics across the whole plan library.

## Start it

```bash
./start                      # from the skill directory — opens your browser
```

That's the whole setup. There is nothing to install and nothing to build: the server is plain Node
(22.6+, which runs TypeScript directly) and the client is native ES modules with preact, htm, marked
and three fonts vendored in this repo, so it also works offline.

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
./start --uninstall-agent
```

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
| **Autopilot** | Drive a plan unattended: one `claude -p` per phase, with the model, effort, skills and tool set chosen per run or per phase; the live session console; the approval queue; and the controls to pause, stop, retry, skip or run a single phase. |
| **Search** | Full text across all plans and handoffs, grouped by plan. |

The page updates itself: a watch on `docs/` pushes changes over server-sent events, so a handoff
written by an agent session appears without a reload.

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

**Stopping a phase.** Two pauses, deliberately named apart. *Pause after this phase* waits for the
work in flight to finish and be verified. *Freeze now* stops the session where it stands (`SIGSTOP`)
— instant, reversible, and it loses nothing, because the process is still there holding its session.
A freeze left longer than fifteen minutes converts itself into a checkpoint instead: the child is
asked to stop, its session id is written into the run, and Continue picks it up with `--resume`. A
stopped process holds its memory and a prompt cache that expires anyway, so an overnight freeze is
not the cheap option it looks like.

**Being told.** Three paths, in increasing order of how far they reach.

*In this tab* is the Notification API: free, instant, and gone with the tab. *On this device* is a
push subscription — a service worker and a VAPID keypair, so the notification arrives with the
console closed and the phone locked. Both are in **Settings → Notifications**, per device, across
eight categories: permission needed, halted, parked, phase finished, plan finished, work became
ready, plans changed, console problems. Only the first two are sent urgent. A **Send a test** button
goes out through the real push service and back, so it proves the chain rather than the last hop.

`PHASE_CONSOLE_NOTIFY=<command>` covers what neither can: a machine with no browser in the picture at
all. It is run as `cmd "<title>" "<body>"`, and is an environment variable rather than a setting
because it runs a command on this machine.

Payloads are encrypted to the subscribing browser ([RFC 8291](https://datatracker.ietf.org/doc/html/rfc8291)),
so a push service relays a notification about your plans without being able to read one. As with the
rest of this console, there is nothing to install — `node:crypto` has every primitive it needs.

**What it will not do.** `permissions.deny` is handed to every session at CLI scope and is the layer
that holds with this console dead — measured, not assumed. The `ask` list goes through an HTTP hook
that **fails open**, so it carries workflow and never safety. Settings shows both, and says which is
which. Rules can be added from there to `deny` and `ask` only: widening what an agent may do at 3am
is a deliberate edit of `~/.config/phase-console/autopilot.json`.

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
node --test "test/*.test.ts"                                            # unit tests
PHASE_CONSOLE_TEST_ROOT=~/code/your-repo node --test "test/*.test.ts"   # + integration & engine parity
```

The suite needs nothing installed. The integration tests skip unless `PHASE_CONSOLE_TEST_ROOT` points
at a real plan library. Type checking does need types — `tsc` cannot resolve `node:*` without
`@types/node`, so run it in a scratch copy rather than putting a `node_modules` inside the skill:

```bash
cp -R server test tsconfig.json package.json /tmp/pc-tc && cd /tmp/pc-tc
npm i -D typescript@5 @types/node@22 && npx tsc --noEmit
```

```
server/   index.ts (http) · service.ts (the model) · engine.ts (script wrapper) · store.ts (files)
          parse/ (front matter, plan, handoff, folder artefacts) · analysis/ (graph, stats)
          search.ts · git.ts · memory.ts · watch.ts · writes.ts · api/routes.ts
          log.ts (structured log + exit record) · lifecycle.ts (degraded state, ordered shutdown)
web/      app.js · router.js · store.js · api.js · views/ · components/ · styles/ · vendor/ · fonts/
deploy/   agent.sh (launchd install/uninstall/status/restart/log)
```

Fonts are Archivo Narrow, Public Sans and JetBrains Mono (SIL Open Font License), vendored as WOFF2.
