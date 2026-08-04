## One switch per category, and it governs every way a message could reach you

**Notifications → Preferences** has a switch per category. It is not a push setting. Turning a
category off means that category produces:

- no record in the inbox,
- no live event to an open tab,
- no out-of-band hand-off to whatever `PHASE_CONSOLE_NOTIFY` points at,
- and no push to any device.

A category that is off leaves no trace anywhere. That is worth stating because the obvious
alternative — silencing only the buzz — leaves the badge climbing and the inbox filling, which is
how people end up ignoring the inbox entirely.

| Category | Tells you | Default |
|---|---|---|
| **Permission needed** | A session is blocked on a decision only you can make. Nothing proceeds until you answer. | On, urgent |
| **A phase needs you** | A phase stopped at a check no automation may sign off. Not failed, not finished — waiting. | On, urgent |
| **Run halted** | A run stopped on something that must not be automated past, or was interrupted with nothing driving it. | On, urgent |
| **Run parked or waiting** | Every remaining phase needs a person, or a usage window has to reopen. | On |
| **Phase finished or failed** | Each phase as it lands, with what it cost. | On |
| **Plan finished** | A run reached the end of its plan. | On |
| **A session ended** | An agent session or terminal finished while you were not watching, or exited with an error. | On |
| **Console problems** | The console degraded, its file watch went deaf, or it restarted after a crash. | On |
| **Work became ready** | A phase became startable — including because of work you finished yourself, elsewhere. | **Off** |
| **Plans changed on disk** | Any plan or handoff was written. An agent editing a handoff mid-phase fires this. | **Off** |

The last two are off by default because they are firehoses rather than signals. `changed` fires on
every write an agent makes to a document it is in the middle of writing; a channel that always
buzzes is a channel you turn off, and the notification it was hiding goes with it.

**Urgent** is reserved for *nothing proceeds without you*. Those are the three that may interrupt a
focus mode and buzz a wrist.

## Devices only ever narrow

Each browser you have subscribed for push has its own category list, and it can only **subtract**
from the global one. A category disabled here is not deliverable, so no device can opt back into it,
and a category enabled here still only reaches the devices that asked for it. The global switch is
the ceiling; a device is a filter under it.

You can therefore keep `Phase finished` in the inbox on the laptop and off the phone, but you cannot
have the phone buzz for a category the console does not raise at all — which is the correct answer,
and it means a quiet phone is never hiding a message that exists somewhere else.

Setting push up on a phone is its own walk-through: **Mobile setup**.

## The inbox, and getting it back to zero

Every announcement that survives the switches lands on **Notifications**. A record knows what it is
about — a plan, a run, a phase, a session — so it routes to the thing rather than to a list.

- **Reading a page reads its notifications.** Sitting on a plan or a session page for a moment
  marks that page's records read, scoped to that page. The count falls because you actually looked.
- **Mark all read** on the dashboard card zeroes the count in one act, for the flood you are never
  going to read item by item.
- Nothing is deleted by either. The record stays; only its unread state changes.

> If announcements arrive in the inbox and never anywhere else, `PHASE_CONSOLE_NOTIFY` is unset and
> no device is subscribed — the Notifications page says so at the top rather than leaving you to
> conclude it.
