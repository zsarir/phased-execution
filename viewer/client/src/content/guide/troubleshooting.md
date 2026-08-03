## When a run stops

Four ways a run comes to rest. **Only one of them is a problem.**

### halted

*Something the runner will not decide on its own.*

Verification failed · the plan stopped linting · the board did not flip to done · two phases failed
in a row · the budget ran out · a person is needed.

**Do:** read the halt reason on the Autopilot tab, fix the cause, then Retry that phase and start
again.

### parked

*Every remaining phase is waiting on something outside the run.*

A gate that has not cleared · a lock held by another session · a phase that needs a decision.

**Do:** clear the gate or release the lock, then start the run again. Nothing was lost.

### waiting

*A usage window is exhausted. Nothing is wrong.*

A plan-level limit that only time fixes. A limit on one model instead switches model and carries on.

**Do:** leave it. The run resumes itself at the stated time. Further out than twelve hours and it
parks for you instead.

### interrupted

*A phase was cut off partway.*

You stopped the run, or the console died while a session was working.

**Do:** the phase is never re-run silently — it may have half-landed. Look at what changed, then
Retry or Skip it deliberately.

## Things that look broken and are not

**The board disagrees with what I just did.** It does not: every status the console shows comes from
`scripts/phase-graph.sh`, never recomputed in the browser. If the board and a file disagree, the
file is not what you think it is — run `scripts/validate.sh <slug>` and read what it says.

**A fix I made to the server "did not work".** Node reads `server/` once, at startup. Reloading the
page reloads the client and nothing else. Settings → *This process* says whether the code on disk is
newer than the process, and can restart it where something is supervising it.

**404s in the browser console on the Runs page.** The same thing: a client from disk talking to a
server that started before the autopilot existed. The page says so rather than showing a stack of
failed requests.

**A card I answered on my phone is still on the laptop.** It is not — press it and you get a 404 for
a decision already made, and the queue re-reads itself at that point. Every event that resolves an
approval invalidates the queue in every open tab, so this should be rare.

**Notifications say "handed to the push service" and nothing appears.** Almost always the operating
system rather than anything here: macOS *System Settings → Notifications → your browser*, or Windows
*Settings → System → Notifications*. A Focus or Do Not Disturb mode does the same thing silently.

**Nothing can reach me at all.** No device is subscribed and no `PHASE_CONSOLE_NOTIFY` command is
set, so announcements arrive in the inbox and stop there. The Notifications page says so at the top
when that is the case.

**Two sessions on one phase.** Take the lock (`scripts/phase-lock.sh <slug> claim <N>`) before
building, and release it when you stop. The Statistics page lists every claimed phase and how much
lease is left.
