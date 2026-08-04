# 🚉 Phase Console

> *The whole plan library in one page.*

```bash
phase-console                      # installed as a plugin — from anywhere
./start                            # cloned — from the folder
./start ~/code/your-repo           # skip the picker
./start --allow-writes             # plus the guarded write verbs
./start --allow-run                # plus the autopilot
```

*(First time on a machine: the client is built output — `cd viewer && npm ci && npm run build`, or
let the console's own page tell you. As a launchd agent, `deploy/agent.sh install|update` builds it
for you.)*

A plan library outgrows a terminal: dozens of plans, hundreds of phases, hundreds of handoff files —
and the engine answers for exactly one plan at a time. The console is the portfolio view: what is
ready **right now** across every plan, which lock is holding what, which plan has stalled, how much
work is left, and whether a plan's graph even lints.

| Screen | Contents |
|---|---|
| **Source** | Pick any repository with `docs/plans`. Recent choices are remembered; switch at any time from the left rail. |
| **Plans** | Every plan with progress, ready phases, locks, QA regime and health. Newest activity first; filter by status, ready, locked or repo. |
| **Route** | The plan as a transit map — phases are stations, dependencies are track, and each suggested session batch is a train threading the stations it carries. |
| **Departures** | The board: state, size, dependencies, gates, locks and QA for every phase. |
| **Phase** | Goal, read-first, files, steps, exit criteria, verification — plus that phase's handoff, gate status, lock and its **boot prompt**, ready to copy. |
| **Handoffs** | Every handoff with its front-matter contract, body and the boot prompts it generated. |
| **Analysis** | Critical path, bottleneck, best next phase, remaining weight and sessions, completion timeline, QA table, health issues. |
| **Overview** | Context, architecture, session budget, the phase-graph table, end-to-end verification and the plan's memory entry. |
| **Ready now** | Every ready phase across every plan, ranked by how much it unblocks. |
| **Statistics** | Portfolio totals, velocity, completions calendar, size mix, repos, skills, target models, locks and every health issue. |
| **Autopilot** | Drive a plan unattended: one `claude -p` per phase, the live session console, the approval queue, and the controls to pause, stop, retry, skip or run a single phase. |
| **Agent** | Interactive `claude` sessions in the browser terminal — off unless started with `--allow-agent`; a launcher for model/effort/permission mode/first prompt/skills, and a **New plan with AI** wizard that authors a plan from a brief in the skill's own plan mode. |
| **Terminal** | A real shell in the browser — off unless started with `--allow-terminal`; token-handshaked WebSocket, sessions that survive a reload, a phone key bar. |
| **Search** | Full text across all plans and handoffs, grouped by plan. |

It **updates itself**: a watch on `docs/` pushes changes over server-sent events, so a handoff written
by an agent session appears without a reload.

**One rule governs the design.** `phase-graph.sh` is the only source of truth for done / ready /
waiting, session batches, boot prompts, QA regime and lint — the console shells out to those same
scripts for every status claim and never recomputes it. JavaScript parsing covers only what the
scripts do not expose (prose, phase detail, handoff bodies) plus analysis they do not provide
(critical path, unblock value, velocity). A parity test re-derives every plan's board from that parse
and asserts it matches the engine, so the two readings cannot drift apart unnoticed.

**Writes are off by default.** With `--allow-writes` the console can scaffold a plan or handoff,
record a QA result and manage phase locks — each behind a dialog showing the exact command first.
`--git` is never passed, so it can never commit or push. The server binds to `127.0.0.1`, and keeps
binding there even when you reach it from elsewhere — `--remote` puts an authenticating proxy in
front of the loopback socket rather than opening one on a network.

**Runs are off by default too, behind their own flag.** `--allow-run` enables the **autopilot**: the
console drives a plan unattended, one `claude -p` process per phase, so "clear the session between
phases" needs no implementing — the process exits and takes its context with it. A phase advances only
when three independent checks agree: the plan's own verification passes, `validate.sh` still passes,
and the board re-read *from disk* says done. Nothing asks the session whether it succeeded. Model,
effort and skills are chosen per run or per phase; a command that reaches outside the working tree
raises an **approval** and waits for a person. It is a separate flag from `--allow-writes` on purpose:
a write scaffolds a file, a run edits a repository for hours.

**It runs on a phone.** Watching a run and answering an approval are the two things that cannot wait
until you are back at the desk, so the console can be driven from one — over your own private
network, with nothing exposed to the internet. Setup:
[Reaching it from your phone](phone.md).

Details: [viewer/README.md](../viewer/README.md).

---

