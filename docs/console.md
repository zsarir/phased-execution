# 🚉 Phase Console

> *The whole plan library in one page.*

```bash
phase-console                      # installed as a plugin, via npm or via brew — from anywhere
./start                            # cloned — from the folder
./start ~/code/your-repo           # skip the picker
./start --allow-writes             # plus the guarded write verbs
./start --allow-run                # plus the autopilot

cd ~/code/your-repo && phase-console start    # a console for THIS project
phase-console list                 # every console: name, root, port, status
phase-console open [<name>]        # open one in the browser
phase-console stop | restart | status | logs [-f]   [<name>]
phase-console install-skill        # copy the skill where Claude Code reads it
```

*(First time on a machine: the client is built output — `cd viewer && npm ci && npm run build`, or
let the console's own page tell you. As a background agent — `deploy/agent.sh install|update`,
launchd on macOS, systemd on Linux — the install builds it for you. npm and Homebrew installs ship
it prebuilt — nothing to run.)*

A plan library outgrows a terminal: dozens of plans, hundreds of phases, hundreds of handoff files —
and the engine answers for exactly one plan at a time. The console is the portfolio view: what is
ready **right now** across every plan, which lock is holding what, which plan has stalled, how much
work is left, and whether a plan's graph even lints.

The console is **six destinations**, a command palette, a bell drawer and a help sheet. Every older
address still resolves — a bookmark, a handoff link or a push notification minted by an earlier
version lands where its page went, keeping whichever half of the address still means something.

| Destination | Answers |
|---|---|
| **Now** | *Does anything need me, and what is running?* The needs-you inbox with inline actions (approvals, gates, errands, expired accounts, stalled lanes), the live lanes with heartbeat, cost and ETA, what is next up across every plan, and the plans in flight. |
| **Plans** | *Where is each plan on its route?* Every plan with progress, ready phases, locks, QA regime and health; open one for its Route (the transit map, plus a health panel and the verify-preflight prediction), Phases (state-grouped, with a drawer per phase carrying gate, lock, QA and evidence), Run, Handoffs and Source. |
| **Runs** | *What has this cost and what happened?* The fleet table with settled-today against the day cap, and per run: the status strip, the ways forward, the lanes and their panes, the state-grouped phases with evidence, liveness and rulings, the timeline, and the journal. |
| **Sessions** | *What processes exist?* One list for autopilot lanes, agent sessions, shells and the Claude sessions the presence hook reports — and one pane, the phone-first browser terminal, for the two kinds this console holds a pty for. |
| **Insights** | *How long, how much, how fast?* The estimate and the basis under it, settled spend against the caps, a plan's QA verdicts, the velocity trend and completions calendar, the state and size mix, the locks and health issues, and the repos, skills and models the work runs on. Portfolio-wide, or scoped to one plan with `?plan=`. |
| **Settings** | *What may this console do, and as whom?* Eight addressed sections — General, Appearance, Automation, Accounts, Alerts, MCP servers, Permissions, This process — each at `#/settings/<section>`, so a setting can be linked to from a handoff, a guide page or a note. |

Riding on every page, on the query string rather than as pages of their own:

| Overlay | What |
|---|---|
| **⌘ K palette** | Search across plans and handoffs, plus every verb and every destination by name. `/` opens it without a modifier. |
| **Bell drawer** | What still needs a person, and the log of everything the console has announced — the same rows as Now's inbox, from the same component, so answering one on a phone clears it on the laptop. |
| **Help sheet** | This guide, in the app, at `?help=<section>`. |
| **Usage meters** | In the chrome on every page: each Claude account's 5-hour, weekly and per-model windows with reset countdowns — the same numbers `/usage` shows. Registering additional accounts sits in Settings ▸ Accounts behind `--allow-accounts`; every launch surface then offers an account per run and an on-limit policy (switch account / wait / pause). |
| **Source picker** | Chromeless and full-screen at `#/source`, because until a root is open there is nothing to navigate to. Settings ▸ General is the door. |

It **updates itself**: a watch on `docs/` pushes changes over server-sent events, so a handoff written
by an agent session appears without a reload.

## More than one project

One install, one console per project. `cd` into a repository and start — it gets its own port, its
own state and its own supervisor, and the consoles for your other projects keep running:

```bash
cd ~/code/alpha && phase-console start     # http://127.0.0.1:4123
cd ~/code/beta  && phase-console start     # http://127.0.0.1:4187 — a different console
phase-console list                         # both, with their roots and ports
phase-console open alpha                   # by name, from anywhere
phase-console restart beta                 # every verb takes the same selector
```

An **instance** is a repository root. Its identity is derived from the path, so it survives restarts
and reboots without anything being written down: the same root is always the same console.

| | |
|---|---|
| **Which one a verb means** | The console for the directory you are standing in. Name one explicitly with `phase-console <verb> <name>`, `--instance <sel>` or `--root <dir>`. A selector matches an id, a name, or a unique folder name. |
| **Port** | The first console you ever ran keeps **4123**. Every other project derives one from its path in **4124–4223** — stable across restarts, and never guessed twice. If something already holds it, the server takes the next free one and records what it actually bound. |
| **Name** | The folder name, unless the project says otherwise. Commit a `.phase-console.json` with `{"name": "…"}` to name it for everyone who clones the repo — and to pin a port with `{"port": 4150}`. |
| **State** | Logs, notifications, push devices and settings are per console. The first one keeps the paths it has always used, so nothing moves on upgrade; the rest live under `instances/<id>/`. Run journals are keyed by repository already and are shared by nobody. |
| **Supervisor** | Each installed console gets its own launchd/systemd unit. The first keeps the plain `com.phase-console` / `phase-console.service` names; the others are suffixed with their id, so installing a second never renames the one you already have. |

`phase-console status` with no selector reports **all** of them. Ports are reserved by registration
rather than by being bound, so a stopped console still owns its port and a restart lands where it
was — and starting a second console on a port that belongs to another project is refused, naming the
project that owns it rather than failing with an address-in-use.

**One rule governs the design.** `phase-graph.sh` is the only source of truth for done / ready /
waiting, session batches, boot prompts, QA regime and lint — the console shells out to those same
scripts for every status claim and never recomputes it. JavaScript parsing covers only what the
scripts do not expose (prose, phase detail, handoff bodies) plus analysis they do not provide
(critical path, unblock value, velocity). A parity test re-derives every plan's board from that parse
and asserts it matches the engine, so the two readings cannot drift apart unnoticed.

**Writes are off by default.** With `--allow-writes` the console can scaffold a plan or handoff,
record a QA result, manage phase locks, and close or reopen a plan — each behind a dialog showing the
exact command first.
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

