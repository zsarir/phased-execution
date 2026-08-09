## The easiest way — let the console write the launcher

**Settings ▸ Desktop launcher ▸ "Create the Desktop launcher — full options".** One click, and the
file is on your Desktop with this console's own root and port baked in and all five switches on.

| | What lands on the Desktop | The first time you open it |
|---|---|---|
| **macOS** | `Phase Console.command` — double-click it. | It can install the login agent, which builds the client once. |
| **Linux** | A `.desktop` entry that runs the start command in a terminal. | On GNOME, right-click it once and choose *Allow Launching* — new entries start untrusted. |
| **Windows** | Nothing. The console runs on macOS and Linux. | Install it inside WSL and start it from your WSL shell. |

The button stays disabled until a source directory is open, because the launcher bakes that
directory in as its `ROOT`.

> The Desktop file is a **copy, not a link**. Updating the skill does not update it — it warns you
> when it is older than the one in the repository, and pressing the button again is the whole fix.

## Or copy the one line that starts it

**Settings ▸ Start with every capability** composes the exact command from this console's own facts
— its source directory, its port, and all five switches — and gives you a Copy button.

Paths render as `$HOME/…` rather than absolute, so the line works pasted on any account and a
screenshot of that page carries no username.

## Pick your way in

Every route below runs the same console. The switches are identical whichever you choose; which
install you have changes only the command's name — `./start` inside a clone, `phase-console`
everywhere else.

| You want | Do this |
|---|---|
| An icon to double-click | **Settings ▸ Desktop launcher** — the button above |
| It up at login, always | `phase-console --install-agent --root <repo> [switches]` |
| To start it from a terminal, here | `phase-console start` |
| To start it from a clone | `./start <repo> [switches]` |
| To try it with nothing installed | `npx phase-console ~/code/your-repo` |
| To reach it from your phone | **Mobile setup** |
| Someone else to do all of it | Paste the prompt further down this page into Claude Code |

How to *install* it in the first place — plugin, clone, npm, Homebrew — is in `docs/install.md`.

## The five switches

Each capability is its own flag, because they have very different blast radii and a wider one is
never implied by a narrower one. **All five are off unless you name them.**

| Flag | What it opens |
|---|---|
| `--allow-writes` | Scaffold plans and handoffs, record QA results, take phase locks, close and reopen plans. It never commits and never pushes. |
| `--allow-run` | **Spawn Claude sessions that edit your repository**, unattended, for hours. The widest of the five. Nothing on the Autopilot tab starts, stops or approves anything without it. |
| `--allow-terminal` | A **real shell** in the browser, running as you, with no policy in front of it. |
| `--allow-agent` | Interactive `claude` sessions in that shell, and the *New plan with AI* wizard. The CLI still asks before it acts; you answer in the terminal itself. |
| `--allow-accounts` | Register more than one Claude account, choose one per run, and let a run that hits its usage window move to one with headroom. **The usage meters work without it** — only registering accounts is gated. |

The startup banner says which are on, and the line at the top of this Guide says what *this* console
can do right now.

> Flags are read once, at startup, so turning one on means restarting. Under launchd or systemd they
> live in the plist or unit file — which is what the Desktop launcher rewrites for you.

## Start, stop, restart, status

The lifecycle verbs live on one command:

```bash
phase-console start | stop | restart | status | log | list | open | update
```

Each takes an optional selector — a name, an id, or a project's folder name. With none, it means the
console for the directory you are standing in; `phase-console status` alone reports every console on
the machine. From a clone, `viewer/run` carries the same verbs.

> **`./start` takes a repository, not a verb.** Its first bare argument is rewritten to `--root`, so
> `./start start` asks for a repository called `start` and `./start list` asks for one called
> `list` — both fail on a directory that does not exist, which reads like the verb is broken. Use
> `viewer/run start` or `phase-console start` for the lifecycle, and keep `./start` for what it is
> good at: `./start ~/code/your-repo --allow-run`.

## Keep it running after a reboot

A supervised console starts at login and survives a crash — and it is what makes the app's own
**Restart** and **Shut down** buttons work at all. A window you double-clicked is the server's
parent, not its supervisor, so Settings correctly refuses there.

```bash
phase-console --install-agent --root ~/code/my-repo --allow-writes --allow-run
phase-console --agent-status        # is it up, and on which port
phase-console --agent-log -f        # follow its log
phase-console --agent-restart       # after changing flags
```

launchd on macOS, a systemd user service on Linux. Installing builds the client once; the boot path
never does, so a crash loop cannot burn its throttle interval.

## One console per project

One install, many consoles. `cd` into a repository and start it — the consoles for your other
projects keep running, each on its own port with its own state.

```bash
cd ~/code/alpha && phase-console start     # http://127.0.0.1:4123
cd ~/code/beta  && phase-console start     # a different port, a different console
phase-console list                         # both, with roots, ports and status
phase-console open alpha                   # by name, from anywhere
```

A console belongs to a **repository root**, and its identity comes from that path — so the same
project is always the same console across restarts and reboots. The first console you ever ran keeps
**4123**; every other project derives a stable port in **4124–4223** from its path. Commit a
`.phase-console.json` at the repository root to decide the name and port for everyone who clones:

```json
{ "name": "alpha", "port": 4150 }
```

Both keys are optional. Logs, notifications, push subscriptions and settings are separate per
console; the first keeps the paths it has always used, so a single-project machine gains nothing new.

## Talk to a running phase from any terminal

`btw` puts a question to whichever phase is running right now, without opening the browser:

```bash
btw "are you still on the migration, or did you move on?"
btw --plan my-feature "skip the perf work for now"
```

It finds the console for the directory you are in, or takes `PHASE_CONSOLE_URL`. It needs
`--allow-run`, because it is talking to a live session. The question becomes one more turn in the
same conversation — the context is intact and the phase carries on afterwards.

## Set it up by pasting a prompt

If you would rather not do any of the above by hand, paste this into Claude Code and answer its
questions:

```
Set up a Phase Console launcher on my Desktop.

1. Find the skill: whichever of ~/.claude, ~/.claude-a or ~/.claude-b contains
   skills/phased-execution/viewer/server/index.ts — or, for a packaged install,
   $(npm root -g)/phase-console or $(brew --prefix phase-console)/libexec.
2. Copy viewer/deploy/desktop-launcher.command from there to
   "~/Desktop/Phase Console.command", and make it executable.
3. Open the copy and walk me through the knobs at the top, one at a time:
     ROOT        the repository the console reads — it must contain docs/plans
     WRITES      --allow-writes: scaffold plans/handoffs, record QA, take locks, close plans
     RUNS        --allow-run: spawn unattended Claude sessions that edit ROOT
     TERM_FLAG   --allow-terminal: a real shell in the browser, running as me
     AGENT       --allow-agent: interactive claude sessions + the New-plan wizard
     ACCOUNTS    --allow-accounts: register more than one Claude account and let a
                 run move to one with headroom (the usage meters work without it)
     MCP         --allow-mcp: register MCP servers and attach them to plans and
                 phases (reading the registry and its statuses works without it)
     PORT        leave blank — each project derives its own; set one to pin it
     SUPERVISED  leave "yes" — it installs a launchd agent, and that is what makes
                 the app's own Restart and Shut down buttons work
   Blank out any door I do not want opened, and explain any I am unsure about
   before changing it.
4. Then tell me to double-click it — do not run it yourself. Its first run can
   install a background agent that starts at login, and that is my call.

The Desktop file is a copy, not a link: updating the skill does not update it.
Re-copy it after an update — it prints a warning when it is older than the one
in the repo.
```
