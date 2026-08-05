/**
 * Setup prompts — the text you hand to Claude Code to get something installed.
 *
 * These live here, in `shared/`, for the same reason the route vocabulary does:
 * the same words appear on the Settings page, in the in-app guide and in the
 * README, and three hand-written copies of an install procedure drift within a
 * release. One string, imported by the page and asserted verbatim against the
 * two markdown files by `test/setup-prompts.test.ts`.
 *
 * These are *setup* prompts, not boot prompts. A boot prompt is composed by
 * `phase-graph.sh` and copied byte for byte — the console never writes one,
 * because a second implementation of it would diverge. Nothing owns "how do I
 * get a launcher onto my Desktop", so it is owned here.
 *
 * Each one is written to be pasted into Claude Code as-is, and deliberately
 * stops short of running anything with consequences: the launcher's first run
 * can install a background agent that starts at login, which is the reader's
 * decision and not the assistant's.
 */

/** Create (or refresh) the double-click launcher on the Desktop. */
export const DESKTOP_LAUNCHER_PROMPT = `Set up a Phase Console launcher on my Desktop.

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
     PORT        leave blank — each project derives its own; set one to pin it
     SUPERVISED  leave "yes" — it installs a launchd agent, and that is what makes
                 the app's own Restart and Shut down buttons work
   Blank out any door I do not want opened, and explain any I am unsure about
   before changing it.
4. Then tell me to double-click it — do not run it yourself. Its first run can
   install a background agent that starts at login, and that is my call.

The Desktop file is a copy, not a link: updating the skill does not update it.
Re-copy it after an update — it prints a warning when it is older than the one
in the repo.`;

/**
 * Install the skill and, if wanted, the console — the README's first prompt.
 *
 * Written for someone who has just found the repository, so it starts before
 * the clone and ends at a URL that either loads or does not. The flags are the
 * one part it refuses to hurry: `--allow-run` spawns unattended sessions that
 * edit a repository for hours, and a reader who pasted a command without being
 * told that has been handed a decision they did not know they were making.
 */
export const INSTALL_PROMPT = `Install the phased-execution skill for me, and ask before each step.

1. Install the skill itself, whichever way I prefer — offer all of these:
     Plugin:  claude plugin marketplace add zsarir/phased-execution
              claude plugin install phased-execution@mobin
     Clone:   git clone https://github.com/zsarir/phased-execution \\
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
                      for hours — the widest of the four, say so plainly
     --allow-terminal a real shell in the browser, running as me
     --allow-agent    interactive claude sessions and the New-plan wizard
   Default every one of them to off. Then install with only what I chose:
     bash <skill>/viewer/deploy/agent.sh install --root <repo> [flags]
   (from npm or brew: phase-console --install-agent --root <repo> [flags])
   That installs a login agent (launchd on macOS, systemd on Linux) that
   starts at login and survives a crash.
5. Open http://127.0.0.1:4123 and confirm it loads. If it does not, read
   ~/.local/state/phase-console/console.err.log and tell me what it says.
6. Finish by listing what you enabled, what you left off, and how to change it.

Do not turn on a flag I did not agree to, and do not start a phase run to
"test" it — a run edits my repository.`;

/**
 * Turn a loopback console into one a phone can open — the README's second prompt.
 *
 * The order is the whole point. `tailscale serve` publishes 443 immediately,
 * but the console refuses every proxied request until `--remote` names the
 * hostname it now answers to, so serving first and re-installing second is the
 * sequence that never leaves a window where the URL is live and broken. The
 * hostname and login are read out of the CLI rather than typed, because both
 * are easy to mistype and the failure mode — a 421 or a 403 — reads like the
 * feature is broken rather than like a typo.
 */
export const TAILSCALE_PROMPT = `Make my Phase Console reachable from my phone over Tailscale.

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
     bash <skill>/viewer/deploy/agent.sh install --root <repo> [existing flags] \\
       --remote <Self.DNSName without the trailing dot> \\
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
header is trustworthy only because nothing but the proxy can reach the port.`;

/** Everything above, by id, so a surface can enumerate rather than hard-code. */
export const SETUP_PROMPTS = [
  {
    id: 'install',
    title: 'Install phased-execution',
    lede: 'Skill, console and flags — each door explained before it is opened.',
    prompt: INSTALL_PROMPT,
  },
  {
    id: 'desktop-launcher',
    title: 'Create a Desktop launcher',
    lede: 'A double-click that starts the console — supervised, so Restart and Shut down work.',
    prompt: DESKTOP_LAUNCHER_PROMPT,
  },
  {
    id: 'tailscale',
    title: 'Reach this console from your phone',
    lede: 'Publish it on your tailnet over HTTPS — still bound to loopback, still private.',
    prompt: TAILSCALE_PROMPT,
  },
];
