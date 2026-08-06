## Nothing will start

If the Autopilot tab shows the plan but every start button is dead, the console was started without
`--allow-run`. **The line at the very top of this Guide page says which it is** — it reads this
console's own switches rather than describing a console in general.

The fix is a restart with the flag: **Launch ▸ The five switches** has the command, and Settings ▸
Start with every capability composes it for you. Under launchd or systemd the flags live in the plist
or unit, so change them there — the Desktop launcher card rewrites both.

## When a run stops

Four ways a run comes to rest. **Only one of them is a problem.**

| It says | What happened | Do |
|---|---|---|
| `halted` | Something the runner will not decide alone. | Read the halt reason, fix the cause, Retry that phase. |
| `parked` | Everything left is waiting on something outside the run. | Clear the gate or release the lock, then start again. |
| `waiting` | A usage window is exhausted. | Leave it. It resumes itself. |
| `interrupted` | A phase was cut off partway. | Look at what changed, then Retry or Skip deliberately. |

## Halted

*Something the runner will not decide on its own.*

Verification failed · the plan stopped linting · the board did not flip to done · two phases failed in
a row · the budget ran out · a person is needed.

Read the halt reason on the Autopilot tab, fix the cause, then Retry that phase and start again. If
the phase actually did its work and only failed to close itself out, **Closeout** is the verb rather
than Retry — see **Autopilot**.

## Parked

*Every remaining phase is waiting on something outside the run.*

A gate that has not cleared · a lock held by another session · a phase that needs a decision.

Clear the gate or release the lock, then start the run again. Nothing was lost — "Why this is
stopped" names each blocker with its remedy.

## Waiting

*A usage window is exhausted. Nothing is wrong.*

A plan-level limit that only time fixes. A limit on one model instead switches model and carries on.

Leave it: the run resumes itself at the stated time. Further out than twelve hours and it parks for
you instead. With more than one account registered, **On usage limit ▸ switch** moves it to an
account with headroom rather than waiting at all.

## Interrupted

*A phase was cut off partway.*

You stopped the run, or the console died while a session was working.

The phase is never re-run silently — it may have half-landed. Look at what changed, then Retry or
Skip it deliberately.

## Things that look broken and are not

**The board disagrees with what I just did.** It does not: every status comes from
`scripts/phase-graph.sh`, never recomputed in the browser. If the board and a file disagree, the file
is not what you think it is — run `scripts/validate.sh <slug>` and read what it says.

**A fix I made to the server did not work.** Node reads `server/` once, at startup; reloading the page
reloads the client and nothing else. Settings ▸ *This process* says whether the code on disk is newer
than the process, and can restart it where something is supervising it.

**404s in the browser console on the Runs page.** The same thing: a client from disk talking to a
server that started before the autopilot existed. The page says so rather than showing a stack of
failed requests.

**A card I answered on my phone is still on the laptop.** It is not — press it and you get a 404 for a
decision already made, and the queue re-reads itself at that point.

**Notifications say "handed to the push service" and nothing appears.** Almost always the operating
system: macOS *System Settings ▸ Notifications ▸ your browser*, or Windows *Settings ▸ System ▸
Notifications*. A Focus or Do Not Disturb mode does the same thing silently.

**Nothing can reach me at all.** No device is subscribed and no `PHASE_CONSOLE_NOTIFY` command is set,
so announcements arrive in the inbox and stop there. The Notifications page says so at the top.

**The usage alerts went quiet.** Check whether **Usage alerts** got switched off — see **Alerts ▸
Turning off the usage-limit alerts** for what that silences.

**Two sessions on one phase.** Take the lock (`scripts/phase-lock.sh <slug> claim <N>`) before
building, and release it when you stop. The Statistics page lists every claimed phase and how much
lease is left.
