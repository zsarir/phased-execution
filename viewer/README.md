# Phase Console

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
| **Search** | Full text across all plans and handoffs, grouped by plan. |

The page updates itself: a watch on `docs/` pushes changes over server-sent events, so a handoff
written by an agent session appears without a reload.

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
