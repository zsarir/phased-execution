# Install

You need [Claude Code](https://claude.com/claude-code); the skill itself needs just Bash. The
**console** additionally needs **Node 22.18 or newer (or 23.6+) with npm** — its client is built
output: one `npm ci && npm run build` inside `viewer/` per machine on the plugin and clone routes,
already built for you on the npm and Homebrew routes. You do not have to remember that: an unbuilt
console serves a page naming the two commands and the exact directory to run them in.

Pick a route. A and B give you the skill **and** the console from one tree; C and D install the
console as a package (with the skill's files inside for the console's own use — Claude Code still
discovers the *skill* from A or B).

## Route A — as a plugin *(recommended: one line, updates itself)*

A **plugin** is a package Claude Code installs for you. A **marketplace** is a catalog that lists
plugins. This repository is both — it ships a catalog called `mobin` containing one plugin, itself.
So installing is one command for each.

**Step 1.** Open Claude Code in any project and type:

```
/plugin marketplace add zsarir/phased-execution
```

Claude Code clones this repository, checks the catalog inside it, and remembers it as `mobin`.
Nothing is installed yet — a marketplace is only a list.

**Step 2.** Install the plugin from that catalog:

```
/plugin install phased-execution@mobin
```

The `@mobin` part says which catalog to take it from. It matters once you have several registered.

**Step 3.** Load it:

```
/reload-plugins
```

Or just restart Claude Code. Type `/plugin` to confirm it is listed — that screen also has an
**Errors** tab if something failed.

**What you now have.** The skill, as `/phased-execution:phased-execution` — Claude Code puts every
plugin's skills under the plugin's name so two plugins can both ship a `review` skill without
clashing. Type `/phased` and let autocomplete finish it. You will rarely type it at all: the skill
describes itself well enough that Claude reaches for it on its own when work is phased. You also get
`phase-console`, a command that starts the web app from any directory — the first run serves a page
naming the client's one-time build (`npm ci && npm run build`, with the exact path printed, since a
plugin lives in a cache directory you would otherwise have to hunt for).

**Keeping it current.** `/plugin update phased-execution`. This plugin sets no version number on
purpose, which puts it on the *commit channel*: every push to `main` counts as a new release, and
Claude Code also refreshes in the background. Restart to apply an update. An update moves the plugin
to a fresh directory, so the console will ask for its build once more — same two commands, same
printed path. (npm and Homebrew are the **tagged channel** instead: releases are `vX.Y.Z` tags with
a [CHANGELOG](../CHANGELOG.md), packed and published by CI with provenance. Same tree, two cadences
— the plugin tracks every commit, the packages track releases.)

**Removing it.** `/plugin uninstall phased-execution@mobin`, then optionally
`/plugin marketplace remove mobin`.

## Route B — as a plain folder *(if you want to edit the skill, or script against its path)*

```bash
git clone https://github.com/zsarir/phased-execution.git ~/.claude/skills/phased-execution
```

Restart Claude Code. The skill is `/phased-execution` — no prefix, because it is not inside a plugin.
Build the console's client once (`cd ~/.claude/skills/phased-execution/viewer && npm ci && npm run
build`), then start it with `~/.claude/skills/phased-execution/start`. Update with `git pull`, then
rebuild — `./start --agent-update` does both build and restart if it runs as a launchd agent.

## Route C — npm *(the console as a package, prebuilt)*

```bash
npm install -g phase-console          # or one-off: npx phase-console ~/code/your-repo
```

You get the `phase-console` command on PATH with the client **already built** — the per-machine
build step from A/B does not exist here. The whole tree ships inside the package (at
`$(npm root -g)/phase-console`), so the console's write verbs, prompts and QA templates all work;
what an npm install does *not* do is register the skill with Claude Code — pair it with Route A if
you want `/phased-execution` in your sessions. Update with `npm update -g phase-console`; if you run
the background agent, follow with `phase-console --agent-restart`. Remove with
`npm uninstall -g phase-console`.

## Route D — Homebrew *(macOS and Linux, from the `zsarir` tap)*

```bash
brew install zsarir/homebrew-tap/phase-console
```

Route C with Homebrew's lifecycle: it lives under `$(brew --prefix phase-console)/libexec`, runs on
Homebrew's own Node, and updates with `brew upgrade phase-console` (then
`phase-console --agent-restart` if the background agent runs). Remove with
`brew uninstall phase-console`.

## Which route?

|  | Plugin | Clone | npm | Homebrew |
|---|---|---|---|---|
| **Install** | two commands, inside Claude Code | one `git clone` | `npm i -g phase-console` | `brew install zsarir/homebrew-tap/phase-console` |
| **Updates** | automatic, every commit | when you `git pull` | `npm update -g`, tagged releases | `brew upgrade`, tagged releases |
| **Skill name** | `/phased-execution:phased-execution` | `/phased-execution` | — (console only; pair with A or B) | — (console only; pair with A or B) |
| **Console** | `phase-console`, from anywhere | `./start`, from the folder | `phase-console`, prebuilt | `phase-console`, prebuilt |
| **Lives at** | a per-version cache directory that moves on every update | wherever you cloned it, permanently | `$(npm root -g)/phase-console` | `$(brew --prefix phase-console)/libexec` |
| **Suits** | wanting it present and current, with nothing to maintain | scripting against the path, or editing the skill itself | wanting the console with no build step | brew-managed machines |

Plugin and clone at once works, but you would see the skill twice and pay its always-on cost twice —
pick one of those two for the *skill*; C or D can sit beside either for the *console*.

## Give yourself a launcher *(optional, and the only way Restart works)*

A double-click that starts the console. Started with `SUPERVISED="yes"` it installs a launchd
agent, which is what makes the app's own **Restart** and **Shut down** buttons work — those exist
only where a clean exit comes back, and a window you double-clicked is the server's parent, not its
supervisor. Paste this into Claude Code:

```
Set up a Phase Console launcher on my Desktop.

1. Find the skill: whichever of ~/.claude, ~/.claude-a or ~/.claude-b contains
   skills/phased-execution/viewer/server/index.ts — or, for a packaged install,
   $(npm root -g)/phase-console or $(brew --prefix phase-console)/libexec.
2. Copy viewer/deploy/desktop-launcher.command from there to
   "~/Desktop/Phase Console.command", and make it executable.
3. Open the copy and walk me through the knobs at the top, one at a time:
     ROOT        the repository the console reads — it must contain docs/plans
     WRITES      --allow-writes: scaffold plans and handoffs, record QA, take locks
     RUNS        --allow-run: spawn unattended Claude sessions that edit ROOT
     TERM_FLAG   --allow-terminal: a real shell in the browser, running as me
     AGENT       --allow-agent: interactive claude sessions + the New-plan wizard
     PORT        change only if 4123 is already taken
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

<details>
<summary><b>Installing from a terminal instead</b> — for dotfiles scripts and container images</summary>

```bash
claude plugin marketplace add zsarir/phased-execution
claude plugin install phased-execution@mobin
claude plugin details phased-execution@mobin      # components + token cost
claude plugin update phased-execution
claude plugin uninstall phased-execution@mobin
```
</details>

---

