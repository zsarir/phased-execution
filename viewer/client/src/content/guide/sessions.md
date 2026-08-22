## One list, four kinds

**Sessions** shows every process this console owns or can see, in one place:

- **Autopilot lanes** — the phases a run is driving. The row links to the run page, where that lane's
  console, approvals, ask box and replay live.
- **Agent sessions** — interactive Claude sessions you opened here.
- **Shells** — a plain shell on this machine, from a laptop or a phone.
- **Other sessions on this machine** — Claude sessions the presence hook reported: your own CLI,
  another console's lane. Read-only here; the row exists because *that* is what a scope conflict is.

Only the middle two are processes this console holds a terminal for, so only those open a pane at
`#/sessions/<id>` and only those offer Close.

`#/agent/<id>` and `#/terminal/<id>` still work — they were two pages until 3.0 and both are in
bookmarks. Each keeps its session id through the redirect; with no id, `#/agent` opens the launcher
and `#/terminal` the new-shell state, because that is what each address meant.

## A session is a process, not a tab

An agent session and a shell are both processes on the machine running this console. Closing the tab
detaches the socket; the process keeps working. Reopening reattaches to it, scrollback and all.

- **Nothing is reaped for being idle.** A session you started an hour ago and have not looked at
  since is still there. Idleness is not evidence of anything — the point of an agent session is that
  it works while you do something else.
- **A session ends when you end it**, or when the console goes down. Nothing else stops one.

The cap of **8** counts live processes only, so records of finished work never crowd out a new
session.

## On a phone

Sessions works under a thumb: the list collapses to the open session and a chevron (the sheet behind
it holds every session, the controls, and the lanes this page cannot open a pane for), then a fixed
key bar with the keys a phone keyboard lacks, a composer for agent sessions, a pty born at the size
of your screen, an `A−`/`A+` font stepper, and reconnects that happen by themselves. **Mobile setup ▸
Driving a session from the phone** walks through it.

## Ended is not gone

A session that exits stays in the list with its exit status until you dismiss it, and for an agent
session that record carries the `claude --resume <id>` that picks the work up again. That handle is
why the record outlives the process: discarding it discards the only way back into the conversation.
Records are dropped 24 hours after death, or when you dismiss them.

Opening `#/sessions/<id>` for a session that has already exited shows that panel — what it was, how
it ended, how to resume it — rather than an empty terminal pretending to connect.

## Where they all are

**Sessions** is the list; **Now ▸ Running now** is the same lanes ranked by what needs you, and the
nav badge counts what is live — so a session started from one plan's page is not lost to another.

The **A session ended** notification category covers the case you cannot see: a session that
finished, detached, while you were elsewhere. Closing one yourself is never announced.

## The console can start the session that unsticks it

Every "Waiting on you" card a Claude session could act on carries a button that opens one. The prompt
is not a text box you fill in: **the server composes it**, reading the board, the run, the phase
diagnosis, the lock and the health issues itself. The browser names only the target.

**Two ways to hand a stuck phase to AI, and every card now says which is which.** *Finish in its own
session* resumes the phase's OWN session through the runner (`claude -p --resume`) — its context is
intact and the run's settings, deny rules and hooks all apply; cheap, and the right first move when a
session stopped one step short. *… with a new agent* opens a FRESH interactive session briefed by the
console with the evidence — fresh eyes that know the facts, not the conversation; it costs a full
session, and you watch it in this tab. Every button carries the exact what-will-happen as its
tooltip (tap the ⓘ on a phone).

| The card says | The button | The session is told to |
|---|---|---|
| A phase halted on its verification | **Fix with a new agent** | Diagnose the failing command, fix the cause, finish the phase. |
| A phase did the work but wrote no handoff | **Close out with a new agent** | Close the phase out — commit, handoff, board. |
| A run was interrupted | **Pick up with a new agent** | Continue from where it stopped. |
| The session stopped at a sign-in | **Pick up with a new agent** | Continue after you sign in — the card routes you to the login first. |
| A claim is stale | **Take over with a new agent** | Take the phase over from a session that is gone. |
| A plan will not parse | **Repair the plan with a new agent** | Repair the plan against the format the engine reads. |

**The outcome is checked, not assumed.** When the session exits, the board is re-read from disk and
the notification says which it was — the phase is done, or it is still waiting and wants your eyes.

## When it refuses

Three situations, and it says which rather than making a mess: while the autopilot is driving, while
a recovery for that same phase is already live (the refusal links to it, so you land in the running
session instead of being told no), and when the problem is that you are signed out.

A recovery of a run working on `pe/<slug>` is told to commit there — checking the branch out first if
the repository is not on it, or using the run's linked worktree when one exists.

## Asking for a review

Recording a QA verdict was always possible; **getting** one is the other half. From a finished phase
— on its panel, in a run's phase table, or on a Ready row whose QA failed before — **QA this phase**
opens a session whose brief is the skill's own `--qa-prompt`, embedded verbatim, plus what the engine
cannot know: the handoff the phase wrote, its key files, the commits that touched it, and that
phase's exit criteria and verification quoted rather than summarised.

You choose model, effort, permission profile and skills, exactly as for any agent session.

**The session records the verdict; the console only reads it back.** The brief ends with the exact
`qa-record.sh` line, report path already filled in, and when the session exits `test-status.md` is
re-read and compared with a snapshot taken at launch. A session that ended without running that
command is reported as *no verdict recorded* — including on a phase that already read `pass`, where
assuming otherwise would be the easiest possible lie.

## Four things a review will not do

1. **Resume the session that built the phase.** A review is a fresh reading or it is not a review.
2. **Run while the autopilot drives.** A review reads the working tree and runs the phase's tests; a
   run on any phase invalidates both.
3. **Run while a session is still building that phase.** Reviewing a moving target is not a review.
4. **Start twice for the same phase.** The refusal carries the live session, so you open it.

Turning QA on for a plan goes through the skill's own `--qa` path, which **waives the phases that are
already finished** rather than gating them. Switching QA on must not make five green phases go yellow
and stall everything downstream of them.

## The off switch

The console has always had a **Restart** button and never a **Stop** one, for the same reason Restart
works at all: under launchd `KeepAlive` (or systemd `Restart=always`), exiting *is* restarting. So
stopping a console meant a terminal and `launchctl` — the exact situation a browser UI exists to
remove.

**Settings ▸ Shut down** does it properly:

- **It does the right thing per supervisor** — `bootout` under launchd and `systemctl --user stop`
  under systemd, so the job is unloaded and stays off; a graceful exit anywhere else.
- **The dialog is an inventory, not a warning.** It lists what will stop: the run (checkpointed
  first, and it resumes when the console comes back), each live agent session, each terminal, and the
  command that starts it all again. *Are you sure?* is not a question anybody can answer; *this stops
  2 agent sessions and the demo run* is.
- **It is not behind `--allow-run`**, unlike Restart. A read-only console is the common case, and the
  one thing every console must be able to do is stop.

**Restart** shows the same inventory, because it has always killed every pty on its way out and never
said so.
