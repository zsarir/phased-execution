## Two layers, and they are not equally strong

The difference matters most on the night the console falls over. One layer is enforced inside Claude
Code with no network involved; the other is an HTTP call to this console, and a call that cannot be
made does not stop anything.

## The deny list holds

Enforced inside Claude Code itself. **Measured still blocking with the console unreachable.**

`git push`, `terraform apply`, `terraform destroy`, `sudo`, publishing a package, `kubectl delete`.

Nothing can approve past these at run time. Add your own in
`~/.config/phase-console/autopilot.json`, or from **Settings** — your rules merge on top of the
defaults, and shipped defaults can be struck by name (each list has ↩ and **Restore defaults** as
the ways back). Striking a shipped **deny** rule is the one edit Settings confirms first: it widens
what every future run may do, with this console dead included.

## The approval hook does not

It is an HTTP call to this console, and Claude Code treats a call it cannot make as a **non-blocking**
error. Measured: with nothing listening, the tool ran.

So approvals are **workflow**, not safety. They let you decide from a phone; they are not what stands
between an agent and a deploy.

> This is why anything genuinely irreversible belongs in the **deny** list rather than the ask list,
> and why the guide says so here rather than burying it.

## The three lists

| List | Enforced by | Behaviour |
|---|---|---|
| `deny` | The CLI | Never runs, whatever you click. The wall — editable in Settings, behind its one confirm. |
| `ask` | The HTTP hook | Raises a card and waits. **Fails open** if the console is not running. |
| `allow` | The CLI | Runs unasked. The ones *you* add outrank the ask list. |

Evaluation order is **deny → allow-you-wrote → ask → allow**. First match wins, and **specificity is
irrelevant** — a more specific rule does not beat an earlier one.

## Permission profiles

A profile is the posture a whole run takes, chosen when it starts. **Only the ask list moves; `deny`
is identical in all three.**

| Profile | What it means |
|---|---|
| **Guarded** | The ask list is live. Anything on it stops and raises a card. |
| **Trusted** | The workflow asks are dropped; deny still refuses everything on it. For a plan you have already watched run. |
| **Bypass** | Nothing is asked. Deny is still the wall, but nothing else stops. |

`guarded` is the one profile written as an **omission**, so an unrecognised *or absent* profile reads
as guarded. A typo can never grant trust, and a run file written before profiles existed cannot
become trusted because a default moved under it.

## Writing a rule

The builder in **Settings** covers the forms people get wrong from memory.

| Form | Builds | Watch out for |
|---|---|---|
| Command prefix | `Bash(git commit:*)` | Matches at a **word boundary** — `Bash(ls:*)` is `Bash(ls *)`, and does not match `lsof`. `:*` only works at the end. |
| Command glob | `Bash(npm run test *)` | Mind the space: `ls *` is not `ls*`. |
| A whole tool | `WebFetch` | As a deny rule this removes the tool from the session entirely. |
| One parameter | `Agent(model:opus)` | One parameter per rule. `Bash(command:…)` looks like this and is **silently ignored**. |
| A path | `Read(~/.ssh/**)` | Only `Read(…)` and `Edit(…)` paths are consulted. `Write(…)`, `NotebookEdit(…)` and `Glob(…)` paths are ignored. A bare name means anywhere: `Read(.env)` is `Read(**/.env)`. |
| A web domain | `WebFetch(domain:*.example.com)` | Covers subdomains, not the bare domain. |
| MCP | `mcp__server` | Covers everything that server exposes; `mcp__server__tool` is one of them. |
| A directory | `Cd(~/code/**)` | `*` is one segment deep; `**` is any depth. |

**Wrappers are seen through** — `timeout time nice nohup stdbuf command builtin noglob` and bare
`xargs`. Some deliberately are not: `watch`, `setsid`, `flock` and `find -exec` never auto-approve,
because what they actually run cannot be seen from the outside, so they get a card.

Settings lists any rule you have written that **parses and does nothing**, rather than leaving you to
discover it at 3am.

## The shell and the agent page

`--allow-terminal` and `--allow-agent` sit outside everything above, on purpose. A shell is a person
typing — no deny list, no approval hook, no profile; the only policy is whoever is at the keyboard.

An agent session sits in between: the console builds the `claude` command itself from allowlisted
choices (model, effort, permission mode), but once the session is up, approvals happen **in the
terminal**, not in the console's queue.

**Bypass on an agent session exists in exactly one place: a QA review.** A review reads a diff and
runs a phase's tests, and stopping it every few minutes to approve a `git log` is how a review stops
happening. So `permissionProfile` is accepted with a QA launch and refused on every other agent
session — a rule rather than a habit, so the surface cannot drift open later. `trusted` is
deliberately not offered there: it means *no approval card*, and there is no card in a terminal you
are watching.

Neither capability weakens the autopilot's rules. They are different doors into the same machine,
each behind its own flag.

## The push carve-out

`git push` is on the deny wall for every run. The one exception is a run started with the work-branch
and PR-on-completion options: for that run, bare `git push` becomes an approval card and
`gh pr create` stays a card **even under Trusted** — publishing takes one tap, and force-pushes stay
denied outright.

If the console process dies mid-run, that run's CLI-side deny no longer contains bare `git push` (the
destructive shapes still do) — which is why the carve-out is per-run, never global.
