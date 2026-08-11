# MCP servers

MCP (Model Context Protocol) servers are tools your sessions can call: a browser to check the page
actually renders, an issue tracker to read the ticket that asked for the work, a documentation server
so the model reads the current API instead of recalling an old one.

The console's job here is narrow and specific. Claude Code can already connect to MCP servers on its
own — what it cannot do is tell you, *before* an unattended run spends an hour, that the server the
plan chose was never signed in.

## The three places a server gets attached

**The plan.** A line in §Session budget:

```
**MCP servers (every session):** `github`, `context7`
```

and, for a phase that needs something the rest of the plan does not:

```
### Phase 4 — Ship the admin
- **MCP:** `playwright`
```

Both are *registry ids* — what the phase needs, never how to reach it, because the how is
per-machine. They are **unioned**: phase 4 above runs with `github`, `context7` and `playwright`.
This is the durable statement; it lives in the repository and every session gets it.

**The run.** The launch dialog and the Autopilot tab both offer the registry. What you tick here is
added to what the plan named — you cannot untick the plan's, because that is a statement about the
work rather than a preference for one afternoon.

**One phase.** The phase matrix has an MCP column, and a `skip run's` checkbox that drops the *run's*
servers for that phase. The plan's still apply.

## What happens before a phase starts

The console probes the exact set the phase would run with, using a one-turn `claude -p` that never
gets to think. So a server that is not registered, is switched off, or will not connect is found
before the phase costs anything, rather than an hour into it.

That matters because an unattended session cannot fix it. There is no `/mcp` panel in `claude -p`,
and what the CLI does instead is tell the *model* that the tools are unavailable — so the session
improvises around the missing server and hands back work that used none of what you chose it for.

**By default the phase still runs.** It boards without the servers that would not answer, its prompt
names them and tells it to do the work that does not depend on them and to record the rest under
**Outstanding** as an errand for you, and you get one notification per run per server. Change that
under **Settings ▸ Automation → When an MCP server is unavailable**, for one run in the launch
dialog, or for one phase in the run's phase matrix. A plan can insist for itself with
`**MCP policy:** require`, and that outranks the run-level choice.

Why not always park? Because `parked` is a settled status, so a run whose ready phases have all
parked has nothing left to start and halts. One signed-out server stopped an eleven-phase plan that
named no MCP servers of its own — the park was built for the phase that truly needs its server, and
was firing for every phase that merely had one attached.

A phase that does park names both doors: sign the server in, or **Continue without these servers**.
Signing it in requeues everything parked on it, including on a run that has already stopped — you do
not have to remember which of six plans was blocked on the thing you just fixed.

## Keep the set small

Three to six. Every attached server puts its instructions and its tool names into the system prompt
of *every* turn, and adds names that can collide with another server's. Connecting one mid-phase also
busts the prompt cache and re-reads the whole context, which is why attachment happens at a phase
boundary and nowhere else.

The run page shows, per phase, how many times each attached server was actually called. A server
sitting at zero was paid for on every turn and never used.

## Credentials

Three kinds, and the console holds only one of them.

- **OAuth** (Sentry, Linear, Notion, Figma, Vercel…) — press Sign in. That runs
  `claude mcp login <id> --no-browser` in a terminal; the token goes to the Claude CLI's own store,
  which this console never reads or writes. A second writer is how two processes corrupt one login.
- **A token in a header** (GitHub's PAT, for instance) — the console holds this one, in your
  keychain on macOS or a 0600 file elsewhere. It never appears in the registry file, in the UI, or in
  any log.
- **`${VAR}` references** — not a secret, the *name* of one, resolved from the console's own
  environment when a run starts. A team can share a plan naming `postgres` without sharing a DSN.

A URL that carries its own credential (`?token=…`, or `user:pass@`) is refused on add, with the fix
named: put it in a header, where it is kept.

## When a server changes under you

Every probe records the tool names a server advertised. If they change, the card says so and names
what was added or removed, and the badge lights until you have looked.

This is not paranoia about a moving version number. A server whose tool descriptions change is a
server that can change what your sessions are instructed to do — the descriptions go into the prompt.
It is the documented supply-chain attack against MCP, and having written down what the tools used to
be is the only defence a client can offer.

The console also warns when a server exposes a tool marked as requiring a person to approve every
call. An unattended run can never approve one, so a phase that needs it will stall rather than finish.

## Permissions

MCP tool calls do not reach the console's approval hook — only the CLI's own `permissions.deny` list
constrains them. Settings → Permission rules understands `mcp__<server>` (every tool that server
exposes) and `mcp__<server>__<tool>` (one of them). Those rules go into the settings file each run
loads, so they hold whether or not this console is running.

## Flags

Registering a server needs `--allow-mcp`. Reading the registry, the connection statuses and the
catalog does not — seeing what your own sessions connect to is display, not capability.
