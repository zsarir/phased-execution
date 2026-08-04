## Stop 2½ · Give yourself a launcher

Typing `./start` is fine. A launcher is better for one specific reason: started with
`SUPERVISED="yes"` it installs a launchd agent, and **that** is what makes the app's own
**Restart** and **Shut down** buttons work. Those buttons only exist where a clean exit comes
back — a window you double-clicked is the server's parent, not its supervisor, so Settings
correctly refuses there.

Paste this into Claude Code:

```
Set up a Phase Console launcher on my Desktop.

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
in the repo.
```

The file it copies (`viewer/deploy/desktop-launcher.command`) carries the same flags as above,
one knob each, so the doors you open are a decision you make once and can read back later.

## Stop 3 · Open the console with runs enabled

Each capability is its own flag, because they have very different blast radii.

```bash
./start --root ~/code/my-repo --allow-writes --allow-run
```

| Flag | What it lets the console do |
|---|---|
| `--allow-writes` | Scaffold plans and handoffs, record QA results, and take phase locks. |
| `--allow-run` | **Spawn Claude sessions that edit your repository** for hours without you watching. Off by default. Nothing on the Autopilot tab can start, stop or approve anything without it. |
| `--allow-terminal` | Open a **real shell** in the browser — running as you, with no policy in front of it. |
| `--allow-agent` | Open **interactive `claude` sessions** in the browser terminal, and the *New plan with AI* wizard. The CLI asks before it acts; you approve in the terminal itself. |

The startup banner tells you which are on. If you upgrade the skill while a console is running,
**restart it** — the browser reloads the page from disk, but the server is whatever Node loaded at
startup. Settings → *This process* says whether the two have drifted apart, and can restart it for
you when something is supervising it.

## Stop 4 · Start the run

Fresh plan or half-finished plan — the same button.

Open the plan, go to **Autopilot**, pick a model, an effort and a budget, and start.

**Model and effort.** Set for the run, and overridable per phase under *Per phase*. What a phase
runs as is resolved from your choice for this run, then the plan's own `**Model:**` and
`**Effort:**` bullets, then the run's defaults — field by field, so choosing a model does not throw
away an effort the plan asked for.

**Skills.** Every skill a session could invoke — yours, this repository's, and every installed
plugin's — with what each one is for. Ticked skills are named in the boot prompt of every phase, on
top of whatever the plan's own `Skills (every session)` line asks for, which stays fixed because it
belongs to the plan and not to one run.

**Autonomy.**

- *Keep going where it safely can* — moves to the next ready phase after a failure instead of
  stopping. It still halts on two consecutive failures, an exhausted budget, or anything needing a
  person.
- *Stop and ask me* — halts on anything ambiguous: a failed phase, a verification the runner could
  not fully check, a gate.

**Budgets.** Per phase and per run, in dollars. A phase that hits its cap resumes the same session
with a larger one rather than starting over, so the work already done is kept.

## Stop 5 · Each phase runs alone 🟢

One phase, one process. Clearing the context between phases needs no mechanism: the process exits
and the context goes with it.

1. **Gate** — if the phase declares one and it is not clear, the phase parks and the runner tries
   another ready phase.
2. **Lock** — the runner checks who holds the phase. It does not take the lock; the session doing
   the work does.
3. **Prompt** — the boot prompt comes from the engine, unaltered.
4. **Session** — one `claude -p` process, streamed to the Autopilot tab as it works.
5. **Verify** — the runner runs the plan's own verification commands itself.
6. **Lint** — `validate.sh` must still pass.
7. **Confirm** — the board is re-read from disk and must say *done*.

> The last three are the point. A session that exits cleanly claiming success while writing nothing
> halts the run, because nothing here takes the session's word for it.

### Watching it

The session console shows text as it is written, the tool calls it makes, and the work of any
subagent it dispatches — without that last one, a phase that delegates is a silent gap of several
minutes. **Detail** adds the model's own reasoning and every hook call, which are worth having when
something is wrong and noise when it is not.

### Asking it something

The box under the console puts a question to the session that is running *now*. It becomes one more
turn in the same conversation — the context is intact and the phase carries on afterwards — rather
than a reason to stop it. The same question works from any terminal with `btw "…"`. It is framed as
out-of-band before it is sent, so an answer does not turn into a change of direction.

### Pausing it

**Pause after this phase** arms a pause and names the phase that has to finish first; nothing is cut
off, and it can be cancelled until it arrives. **Stop now** is the one that interrupts, and it
records the phase as *interrupted* rather than *failed*, because a phase cut off partway may have
half-finished something.
