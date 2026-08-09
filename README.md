<div align="center">

# 🪜 phased-execution

**A [Claude Code](https://claude.com/claude-code) skill for running work that is too big for one
session — as a dependency graph of right-sized sessions, with a local web console to watch it.**

[![CI](https://github.com/zsarir/phased-execution/actions/workflows/ci.yml/badge.svg)](https://github.com/zsarir/phased-execution/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/phase-console?style=flat-square&color=CB3837)](https://www.npmjs.com/package/phase-console) ![Skill](https://img.shields.io/badge/Claude%20Code-Agent%20Skill-d97757?style=flat-square) ![Platforms](https://img.shields.io/badge/platforms-macOS%20·%20Linux%20·%20WSL2-3fb68b?style=flat-square) ![Dependencies](https://img.shields.io/badge/runtime%20dependencies-none-3fb68b?style=flat-square) ![License](https://img.shields.io/badge/license-MIT-7A8B92?style=flat-square)

**English** · [فارسی](README.fa.md)

![Console ](assets/console.gif)

</div>

```
Phase graph — checkout-rewrite   (3/7 done)

  ✅  1  done         Schema + migrations · QA:verified
  ✅  2  done         Pricing service · QA:verified
  ✅  3  done         Payment adapter · QA:verified
  🔓  4  ready        Cart API
  🔓  5  ready        Refund worker
  ⏳  6  waiting      Checkout UI
  ⏳  7  waiting      Ship (GATED) 🔒GATED needs: 6

READY NOW:   4 5
WAITING:     6(←4), 7(←6)
SUGGESTED BATCHES (budget ~200K, joined phases share a session): [4 5]  [6]  [7]
```

Big work becomes phases with declared dependencies. Each runs in its own right-sized Claude session,
verifies itself, and writes a handoff the next session boots from cold.

_That board is the product. Nothing here stores "what phase am I on" — it is computed, every time,
from your plan's dependency table and the handoff files on disk, so out-of-order and resumed work
stay correct._

---

## Install

| You want                     | Run                                                                                             | Notes                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The console, ready to use    | `npm install -g phase-console`                                                                  | Client prebuilt — no build step. Skill files ship inside for the console's own use |
| … via Homebrew               | `brew install zsarir/homebrew-tap/phase-console`                                                | macOS **and** Linux; runs on brew's Node                                           |
| … without installing         | `npx phase-console ~/code/your-repo`                                                            | One-off, always the latest release                                                 |
| The **skill** in Claude Code | `/plugin marketplace add zsarir/phased-execution` then `/plugin install phased-execution@mobin` | Auto-updates from every commit. Pair with npm/brew, or build its console once      |
| An editable tree             | `git clone https://github.com/zsarir/phased-execution ~/.claude/skills/phased-execution`        | Skill + console from one folder you control                                        |

Then point the console at any repository that has (or should have) `docs/plans`:

```bash
phase-console ~/code/your-repo        # run it, right here
phase-console install-skill           # copy the skill where Claude Code reads it
phase-console start | stop | restart | status | logs   # drive the background agent
```

Works on **macOS** and **Linux**, and on **Windows inside WSL2** — routes, updates, uninstall and
the platform notes live in **[docs/install.md](docs/install.md)**.

### Running several projects at once

One install, one console per project. `cd` into a repository and start it — the others keep running.
(Precedence chain, state layout and phones: **[docs/console.md](docs/console.md)**.)

```bash
cd ~/code/alpha && phase-console start   # http://127.0.0.1:4123
cd ~/code/beta  && phase-console start   # a second console, its own port
phase-console list                       # NAME · ROOT · PORT · STATUS · UNIT
phase-console open beta                  # by name, from anywhere
phase-console stop beta                  # every verb takes the same selector
```

Every verb takes `[<name>]`, `--instance <sel>` or `--root <dir>`; with none it means the console for
the directory you are in, and `phase-console status` alone reports them all. A console belongs to a
repository **root** and its identity comes from that path, so the same project is always the same
console — across restarts and reboots, with nothing written down.

- **Ports.** The first console on a machine keeps **4123**; every other project derives a stable one
  in **4124–4223**, taking the next free port if that one is held. Starting on a port owned by
  another project is refused _by name_.
- **Name it.** Commit `{"name": "alpha", "port": 4150}` as `.phase-console.json` at the repository
  root to decide both for everyone who clones it. Both keys are optional.
- **What is separate.** Logs, notifications, push devices and settings are per console. The first
  console keeps the paths, port and unit name it always had — a single-project machine gains no new
  files and nothing moves on upgrade.
- **At login:** `phase-console --install-agent --root ~/code/beta` gives that project its own
  launchd/systemd unit and leaves any console you already installed alone. Undo with
  `agent.sh uninstall beta` (keeps it registered, unsupervised); `instances.mjs remove <id>` forgets
  it entirely.

### Or hand it to Claude Code

Paste this into Claude Code. It asks before every step and turns nothing on by itself.

```
Install the phased-execution skill for me, and ask before each step.

1. Install the skill itself, whichever way I prefer — offer all of these:
     Plugin:  claude plugin marketplace add zsarir/phased-execution
              claude plugin install phased-execution@mobin
     Clone:   git clone https://github.com/zsarir/phased-execution \
                ~/.claude/skills/phased-execution
     npm:     npm install -g phase-console     (console prebuilt, skill files inside)
     Brew:    brew install zsarir/homebrew-tap/phase-console
   Claude Code discovers the SKILL from the plugin or the clone; npm and brew
   install the console — after one of those, phase-console install-skill puts
   the skill where Claude Code reads it. If I already have it, update it the
   same way instead and tell me what changed.
2. Ask which repository holds my work. The console reads plans from
   <repo>/docs/plans and handoffs from <repo>/docs/handoffs; it will not start
   without docs/plans, so create it if I say to.
3. Ask whether I want the web console at all. The skill works without it — it is
   scripts and markdown. npm and brew ship it prebuilt; for a plugin or clone:
     cd <skill>/viewer && npm ci && npm run build
4. Before enabling anything, explain these one at a time and let me answer each:
     --allow-writes   scaffold plans and handoffs, record QA, take phase locks,
                      close and reopen plans
     --allow-run      spawn unattended Claude sessions that edit my repository
                      for hours — the widest of the six, say so plainly
     --allow-terminal a real shell in the browser, running as me
     --allow-agent    interactive claude sessions and the New-plan wizard
     --allow-accounts register Claude accounts and switch between them mid-run
     --allow-mcp      register MCP servers and attach them to plans and phases
   Default every one of them to off. Then install with only what I chose:
     bash <skill>/viewer/deploy/agent.sh install --root <repo> [flags]
   (from npm or brew: phase-console --install-agent --root <repo> [flags])
   That installs a login agent (launchd on macOS, systemd on Linux) that
   starts at login and survives a crash.
5. Open http://127.0.0.1:4123 and confirm it loads. If it does not, read
   ~/.local/state/phase-console/console.err.log and tell me what it says.
6. Finish by listing what you enabled, what you left off, and how to change it.

Do not turn on a flag I did not agree to, and do not start a phase run to
"test" it — a run edits my repository.
```

---

## Reach it from your phone

Optional, and only worth doing once the console is running. It publishes the console on your own
tailnet over HTTPS — the server itself never stops being loopback-only.

```
Make my Phase Console reachable from my phone over Tailscale.

1. Check the ground first and stop if any of it is missing:
     tailscale status            is it installed, and signed in?
     tailscale status --json     read MagicDNSSuffix, CurrentTailnet.MagicDNSEnabled,
                                 Self.DNSName and User for my login
   If MagicDNS is off, or HTTPS certificates are not enabled for the tailnet,
   tell me to turn both on in the Tailscale admin console (DNS → MagicDNS, and
   DNS → HTTPS Certificates) — they are tailnet-wide settings you cannot set
   from here — then wait for me.
2. Publish the console on the tailnet, on 443, still bound to loopback:
     tailscale serve --bg --https=443 http://127.0.0.1:4123
   Use my real port if it is not 4123. Confirm with: tailscale serve status
3. Re-install the console agent so it answers to that hostname, keeping every
   flag it already has — read them from the current plist / unit, never guess:
     bash <skill>/viewer/deploy/agent.sh install --root <repo> [existing flags] \
       --remote <Self.DNSName without the trailing dot> \
       --remote-user <my login>
   Without --remote the console refuses proxied requests with a 421, so the URL
   would resolve and then fail. With it, the console still listens only on
   loopback: Tailscale terminates TLS, proves who is calling, and forwards.
4. Print the https URL and confirm it answers from this machine.
5. Then tell me what to do on each device I want to use:
     - install Tailscale and sign into the SAME tailnet
     - turn on MagicDNS / "Use Tailscale DNS"
     - open the URL
     - on iOS, add it to the Home Screen — notifications only work from there
   Only devices on my tailnet, signed in as an allowed user, can reach it.

Never widen --host to expose the console on a network interface. The identity
header is trustworthy only because nothing but the proxy can reach the port.
```

The long version, including push notifications and exactly what is enforced →
**[docs/phone.md](docs/phone.md)**

---

## Everything else

**[📖 Full documentation →](docs/README.md)**

[Overview](docs/overview.md) · [Your first plan](docs/first-plan.md) · [The loop](docs/loop.md) ·
[The artifacts](docs/artifacts.md) · [What you control](docs/controls.md) ·
[Session budget](docs/session-budget.md) · [Model handling](docs/model-handling.md) ·
[QA gating](docs/qa-gating.md) · [Safety rails](docs/safety-rails.md) ·
[Phase Console](docs/console.md) · [Install by hand](docs/install.md) ·
[Versioning & releases](docs/releasing.md) · [Reference](docs/reference.md)

Needs Claude Code, plus `bash` and `git`. The console adds Node 22.18+ (or 23.6+) and has **no
runtime dependencies**. Releases: tagged `vX.Y.Z`, published by CI with npm provenance — see the
[CHANGELOG](CHANGELOG.md). MIT — see [LICENSE](LICENSE).
