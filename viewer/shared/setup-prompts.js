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
   skills/phased-execution/viewer/server/index.ts.
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
in the repo.`;

/** Everything above, by id, so a surface can enumerate rather than hard-code. */
export const SETUP_PROMPTS = [
  {
    id: 'desktop-launcher',
    title: 'Create a Desktop launcher',
    lede: 'A double-click that starts the console — supervised, so Restart and Shut down work.',
    prompt: DESKTOP_LAUNCHER_PROMPT,
  },
];
