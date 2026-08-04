# Sizing — cost model, model budgets, and batching

Contents: [The real cost model](#the-real-cost-model-why-fresh-sessions-help--and-why-not-always) ·
[Step 1 — know your model](#step-1--know-your-model) ·
[Step 2 — pick the session budget](#step-2--pick-the-session-budget-from-the-model) ·
[Step 3 — right-size and batch](#step-3--right-size-and-batch) ·
[Size annotation](#size-annotation-optional-drives-the-engine) ·
[Keep the session lean](#keep-the-session-lean-so-the-budget-goes-further)

This is the source of truth for **how big one session should be** (the prose + rationale). The **machine
values** — the `S=15K M=40K L=90K` weights and the per-model budgets — live in `scripts/sizing.env`, which
`scripts/phase-graph.sh` sources, so the numbers here and the engine can't drift (F5). Change a number in
`sizing.env` and keep this doc in step. SKILL.md links here; `--session-plan` uses those same values.

## The real cost model (why fresh sessions help — and why not always)

The old rationale was "context is re-read every turn, so cost is quadratic." That is **wrong for an
interactive Claude Code session**, because the harness **prompt-caches the conversation prefix
automatically**:

- A cache **read** costs ~**0.1×** base input; a cache **write** costs ~**1.25×** (5-minute TTL).
- So each turn re-sends the whole conversation, but the large stable prefix is served from cache at
  0.1×; you pay full price only on the small new tail + output. **A warm session is roughly *linear*
  in turns, not quadratic.**

So the lever isn't "avoid re-reads." There are three real ones:

1. **Context rot (quality).** As the window fills, recall and precision degrade — the "lost in the
   middle" effect, attention-budget depletion. This is usually the *first* thing to bite, well before
   cost. A focused session simply produces better code.
2. **Cache-busting events (cost spikes).** A few actions throw away the warm cache and force a
   full-price re-read of the (by-now-large) context: **switching model, changing the effort/reasoning
   level, connecting/disconnecting an MCP server, `/compact`, resuming after a Claude Code upgrade, or
   a >5-minute idle gap (the cache TTL expires)**. Several of these in one long session are where the
   "quadratic" feeling actually comes from.
3. **Bootstrap overhead (the counterweight).** Every fresh session re-pays a fixed cost: reading the
   handoff + plan + memory and re-exploring the code — plus the closeout ceremony the previous session
   paid to hand off (handoff file, commits, boot prompts). Splitting work into *too many tiny* sessions
   wastes this over and over and throws away a warm cache. **This is exactly why adjacent phases that
   fit one budget should share one session.**

**The rule that falls out:** *one coherent, **right-sized** chunk of work per session* — big enough to
amortize bootstrap and keep the cache warm, small enough to stay clear of context rot and the harness
auto-compaction threshold.

## Step 1 — know your model

You (the running agent) already know your own model from your system context (e.g. "powered by Opus
4.8 / `claude-opus-4-8`"). Use it. Phases are *executed* in future sessions that may run a **different**
model than the one planning now — the common split is **Fable plans (Mode 1), Opus executes** — so the
plan records a **target execution model** in its `## Session budget` note (default `claude-opus-4-8`
when the user hasn't said otherwise), and each phase-start re-checks it. If the target is genuinely
unknown, ask with `AskUserQuestion` ("Which Claude model will run these phases?").

## Step 2 — pick the session budget from the model

**Budget is measured in summed phase *weight*** (the `S/M/L` working-set estimates below), **not raw
context.** A phase's weight approximates what its work adds as working set — bootstrap reads, files
opened, tool output, generated diffs. The session's *real* context runs about **~3× the summed weight**
once the system prompt, skills, thinking, tool chatter, and conversation overhead are on top. So the
budget is set to **~0.2 × the effective window**, which lands a full session near **~60% real window
utilization** — enough headroom to finish cleanly below the auto-compaction threshold (~83%) and clear
of the late-window quality rot zone. Filling the window to 100% was the old policy and is a trap: the
weights under-count reality by ~3×, so a "1M budget" session would blow far past the window.

| Model | Max window | Max output | $ in / out per MTok (as of 2026-07) | Session budget preset (weight) | Use for |
|---|---|---|---|---|---|
| Opus 4.8 / 4.7 / 4.6 | 1M | 128K | 5 / 25 | **~200K** (≈600K real ≈ 60%) | the default execution model; hard reasoning / architecture |
| Fable 5 | 1M | 128K | 10 / 50 | **~200K** | planning (Mode 1) + the most demanding long-horizon phases; priciest |
| Sonnet 5 / 4.6 | 1M | 64K | 2 / 10 intro (→3 / 15) · 4.6: 3 / 15 | **~200K** | balanced execution / implementation phases |
| Haiku 4.5 | **200K** | 64K | 1 / 5 | **~40K** | mechanical / cheap phases → smaller phases, more of them |

> **Tokenizer caveat.** Opus 4.7+, Fable 5, and Sonnet 5 tokenize ~30% denser text into ~30% *more*
> tokens than older models — don't reuse working-set counts measured on pre-4.7 models; the S/M/L bands
> already assume the newer tokenizer.

> **Effective-window caveat.** These are the models' *max* windows. The window your Claude Code session
> actually exposes may be smaller by configuration (a 200K effective window is possible even on
> 1M-capable models, and the session auto-compacts near its limit). The **~200K presets assume a
> genuinely ≥1M effective window**. Size to the window you actually have — budget ≈ 0.2 × effective
> window: a 200K effective window → a ~**40K** budget (`--session-plan 40000`).

**Per-phase model selection is a lever too.** You don't have to run every phase on one model. Put hard
reasoning/architecture phases on Opus or Fable, balanced implementation on Sonnet, and mechanical phases
(rename sweeps, codegen, boilerplate) on cheap fast Haiku. A phase can name its preferred model in the
plan; just remember switching models mid-*session* busts the cache, so keep one model per session — a
wanted model switch is one of the few boundaries that *earns* a fresh session.

## Step 3 — right-size and batch

**At plan time (Mode 1) — minimize phase count.** Author the **fewest** phases that fit the budget:
target `phase count ≈ ceil(total weight / budget)`, then add a boundary only where one is *earned* — an
external gate, a deliberate model switch, or a checkpoint the user asked for. Per-subsystem tidiness earns
nothing: extra phases mostly buy repeated bootstrap + handoff ceremony (~30-40% of a typical handoff is
ceremony). The one split that *does* buy something is along **repo boundaries** — phases with disjoint
scopes may run as concurrent sessions (§Scoped concurrency in `conventions.md`), so a fan-out that
separates repos is real parallelism while a fan-out inside one repo is not. *Don't* author three trivial
phases that should be one. A phase whose weight exceeds one session's budget is two phases.

**At phase boundaries (Mode 3):** if any ready phase fits the **remaining** budget (judge with your live
context meter — you should still be comfortably under ~60% of the window when it finishes), continuing
into it in the **same** session is the *efficient* choice — it saves a full bootstrap + closeout and
keeps the cache warm. This is **batching**, and it is encouraged, not a forfeit:

- **Sequential next phase** — the classic case; continue straight into it.
- **Independent siblings (parallel-safe)** — may share a session too: execution inside one session is
  serial, so even same-scope siblings are safe that way. Pick ONE to continue into. The rest run in later
  sessions — **at the same time as this one if their scopes are disjoint** (`conflicts` before each).
- **L-size phases batch like any other** — only the summed budget decides, not the tag.

Stop and open a fresh session when: the budget is spent, the next phase is **GATED** (external gates
never get batched past), it wants a **different model**, or — with QA enabled — it depends on a phase
whose QA verdict isn't recorded yet. Write a handoff for **every** phase as you finish it, even
mid-batch — that's what keeps each phase independently resumable.

### Size annotation (optional, drives the engine)

Tag a phase's rough working-set in its `### Phase N` heading block, mirroring the `Gates` convention:

```
### Phase 3 — wire the endpoint
- **Size:** S
```

| Tag | Rough working set | Looks like |
|---|---|---|
| `S` | ≤ ~15K tokens | a focused edit, a config/migration, one small file, a doc |
| `M` (default) | ~15–50K | a typical feature across a few files with some exploration |
| `L` | ~50–120K | a substantial subsystem, heavy exploration, large diffs |

A phase estimated **above the session budget** is too big for one session — split it (on 1M-class
models that's ~200K of weight; on Haiku ~40K, so an `L` phase never fits a Haiku session). Phases with
**no** `Size:` tag are treated as `M`. These map to token weights `S=15K`, `M=40K`, `L=90K` for batch
math (kept in sync with `scripts/phase-graph.sh` via `scripts/sizing.env`).

### Let the engine propose batches

```
scripts/phase-graph.sh <slug> --session-plan opus     # or: haiku · sonnet · fable · a raw number
```

It walks the remaining (not-done) phases in dependency order and groups phases into sessions wherever
every dependency is already satisfied inside or before the group and the summed weight stays under the
budget — cutting at GATED phases, at unmet dependencies, and (when QA gating is on) before any phase
whose dependency's QA verdict would land in the same session. The plain board
(`scripts/phase-graph.sh <slug>`) also prints a `SUGGESTED BATCHES:` line when sizes are present. Treat
the output as a **suggestion** — you confirm it against your live context meter; absent any `Size:`
tags every phase is treated as `M`.

## Keep the session lean (so the budget goes further)

- **Offload high-token work to subagents.** Broad code search, multi-file exploration, and independent
  verification can run in an `Agent` subagent (e.g. the read-only `Explore` type) that reads a lot but
  returns only a short summary — the tokens it burns never enter your phase session. This is the
  biggest in-session lever for both cost and rot. (Don't over-delegate: a single-file read or a
  sequential edit is faster done directly.)
- **Don't bust your own cache mid-phase:** keep one model and one effort level for the session, and
  prefer opening a *fresh* session over running `/compact` in the middle of a phase.
