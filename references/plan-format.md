# Plan format

Contents: Frontmatter · Sections in order (Title · Context · Architecture · Session budget ·
Phase graph · Phases · End-to-end verification) · Notes

A plan is the durable blueprint for a multi-phase task. It lives at `docs/plans/<slug>.md`, is committed,
and is rarely edited after design. Each phase's detail must be **self-contained** — executable from the
plan + that phase's handoff with no prior conversation — because phases run in fresh sessions (usually
several phases batched per session, sized to the budget; see `references/sizing.md`).

## Frontmatter (required)

```yaml
---
slug: <kebab-slug>          # shared by plan, handoff folder, and project_<slug> memory
created: <YYYY-MM-DD>
status: active              # active | complete | abandoned | superseded
phases: <N>                 # total phase count
handoffs: docs/handoffs/<slug>/
memory: project_<slug>      # or pre-existing project_<other> when reusing an existing memory
closed: <YYYY-MM-DD>        # optional — set by close-plan.sh; absent while the plan is open
closed_reason: <one line>   # optional — why it was closed; required unless closed with --force
---
```

### Open vs closed

`status` answers one question — **does anyone still care about this plan?**

| Status | Meaning | Board |
|---|---|---|
| `active` | open; work is expected to continue | live |
| `complete` | closed, having finished | **closed** |
| `abandoned` | closed without finishing | **closed** |
| `superseded` | closed because another plan took over | **closed** |

The last three are **terminal**. A plan with a terminal status is *closed*, and closure is what stops it
reporting: no stuck-handoff error, no QA-fail error, no missing-handoff/index-drift/stale-lock/
depends-drift warning, no ready phases, no boot prompts, no session batching, and no notifications. Its
board still renders in full — nothing is deleted or hidden — and genuine structural damage (an
unparseable graph, an undefined dependency, a cycle) is still reported, demoted to a note so a broken
closed plan stays findable.

Closure is **not** the same as progress. Progress is computed from the handoffs and is never stored
(see `conventions.md` §Status source of truth); closure is an explicit operator decision, stored here,
and a plan may be closed with phases still unfinished. Set it with the verb, never by hand:

```bash
scripts/close-plan.sh <slug> --reason "why this stops here"     # → abandoned, dated
scripts/close-plan.sh <slug> --status superseded --reason "…"
scripts/close-plan.sh <slug> --reopen                           # → active, fields stripped
```

`--reopen` is always available, so closing is a reversible decision rather than a destructive one.

## Sections (in order)

1. **`# <Title>`** — optionally followed by a provenance blockquote if this plan continues prior work:
   > Continues from `docs/handoffs/<prior-slug>/phase-NN-*.md` and `~/.claude/plans/<scratch>.md`.
   > Memory key: `project_<key>` (pre-existing; NOT a new slug-named memory).

2. **`## Context`** — why this work exists: the problem/need, what prompted it, the intended outcome.
   If a prior handoff claimed incorrect state, add a **Reconciliation note** here:
   > **Reconciliation:** The phase-NN handoff claimed X was uncommitted — it is committed at sha XXXXXXX.
   > Use `git log` as the source of truth; ignore stale handoff claims.

3. **`## Architecture / approach`** — key design decisions; critical files **by repo**; reused utilities.
4. **`## Session budget`** — the model these phases are sized for + the per-session weight budget +
   the branch they commit to + (optionally) the **QA regime** and the **skills every session must invoke**,
   so a future session can re-check them all before building. Record the target model, the budget
   (~0.2 × the effective window in phase weight: 1M-class models → ~200K; Haiku → ~40K), any per-phase
   model overrides, the **branch** (default: the
   current branch — **no new branch** unless the user asked; then ONE branch for *all* phases, including
   independent ones), and — when the user named skills to use for this work — a **`Skills (every session):`**
   line listing them, **backticked** (e.g. `` `design-system` ``). The engine reads that line and
   re-injects those skills into **every** phase's boot prompt (and the QA brief), so each cold-start session
   re-invokes them rather than forgetting them.
   The same shape carries **MCP servers**: when the work needs one, add an
   **`MCP servers (every session):`** line naming them **backticked** (e.g.
   `` **MCP servers (every session):** `github`, `context7` ``). Those are *registry ids* from the
   Phase Console's MCP page — what the phase needs, never how to reach it, because the how is
   per-machine. The engine re-injects them into every boot prompt and the QA brief, the console
   attaches them to the session with `--mcp-config`, and checks them **before the phase is paid
   for** rather than letting a session improvise around a missing tool for an hour. A plan naming a
   server this machine has not registered is reported at plan time as an **F15** warning (advisory —
   it never fails the lint).
   **What happens when one cannot connect is a policy, and the default is to carry on.** The phase
   boards without that server, its prompt names the servers it did not get and instructs it to record
   the gap under **Outstanding** as an operator errand, and the console warns. Add
   `` **MCP policy:** require `` to §Session budget when the work genuinely cannot proceed without
   its servers, and the phase parks at boarding instead. The default moved because the park was
   answering for the phase that truly needs its server and firing for every phase that merely has one
   attached: `parked` is a settled status, so a run whose ready phases all park has nothing left to
   do — one signed-out server stopped an eleven-phase plan that named no MCP servers at all.
   **Keep the set small — three to six.** Every attached server puts its instructions and tool names
   in the system prompt of *every* turn, and attaching one mid-phase busts the prompt cache
   (`references/sizing.md`), which is why attachment happens at a phase boundary and nowhere else.
   **QA is off by default** — add a line with exactly `**QA gate:** on` ONLY when the user asked for QA on
   this work (then every phase-finish dispatches a fresh-context QA subagent); `**QA gate:** off` records
   an explicit waiver (rows written as `waived`, no subagents). Only that exact bolded form is
   machine-read (`phase-graph.sh --qa-mode`). See `references/sizing.md` for sizing and
   `references/conventions.md` §Branches for the branch policy. (The console may override the
   `**Branch:**` line per run with its own work branch — its sessions are told about the mismatch
   and record it in their handoffs; the line here stays authoritative for hand-driven sessions.)
   Example:
   > **Target model:** `claude-opus-5` (1M window) · **Budget:** ~200K weight/session (≈60% of the window) · **Branch:** current branch (no new branch).
   > **Skills (every session):** `design-system`, `some-plugin:test-first`
   > Hard-reasoning phases → Opus/Fable; mechanical phases → Haiku if run in their own sessions.
5. **`## Phase graph`** — a table that makes blocking vs parallel obvious. **This table is machine-read:**
   `scripts/phase-graph.sh` parses the `Depends on` column to compute live readiness, so keep it exact.

   | Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
   |------:|-------|-----------|--------------------|-------|---------------|

   Follow the table with an explicit callout:
   - **Blocking:** `1 → 2 → 4` (linear chains)
   - **Independent (any order; concurrent sessions when their scopes are disjoint):** `3a ∥ 3b`

   Dependency rules + parse format:
   - A phase lists **every** phase that must complete first in `Depends on`. Two phases are *parallel-safe*
     only if neither depends on the other **and** their **scopes** are disjoint (see the Repos column).
   - The `Depends on` cell accepts: a single number (`4`), a comma list (`4, 5`), a **range** (`1–7`,
     en-dash or hyphen, expands to 1…7), combinations (`1–7 (+8–10)`), or `—` for no dependencies. The
     parser keeps digits + range dashes and ignores other punctuation, so prose-y cells still parse.
   - The phase number lives in column 1; **markdown-bold cells (`| **6** |`) are tolerated**, but don't put
     a phase's number anywhere the parser could mistake it. After writing, run `scripts/phase-graph.sh
     <slug>` and confirm the parsed phase count matches the frontmatter `phases:` (it warns on mismatch).
   - **`Repos` is the SCOPE column, and it is machine-read.** It names the repos/paths the phase touches,
     and that is what decides whether two sessions may run at the same time — so write it for every phase,
     not as decoration. Accepts a comma/`+`/space list, `` `backticks` ``, **bold**, parenthetical asides
     (dropped), and paths (`packages/cart-api` stays one token; `/` never separates). `all` means it
     touches everything. **An empty cell also means `all`** — the conservative default, and a phase that
     runs alone for no reason. Check what the engine read with `scripts/phase-graph.sh <slug> --repos N`.
     The cell is the ONLY declaration — nothing in the phase body overrides it. (Plans already use
     `- **Scope …:**` bullets for prose, and reading those as repo names would silently mis-scope a
     phase.) If a phase's real reach differs from its cell, fix the cell.
   - **Gated phases — mark, describe, categorize.** Mark `*(GATED)*` in the `### Phase N` heading, add a
     `- **Gates (must clear first):** …` line (the full conditions — it may span several lines, and for
     human gates it MUST be numbered step-by-step operator instructions; the boot prompt and the console's
     Gate card both render it whole), and add a category directive `- **Gate-check:** <type> <value>`.
     The vocabulary (one source: `scripts/gates.env`) and what each type means:

     | Type | Category | Cleared by |
     |------|----------|-----------|
     | `ai <one-line check>` | **ai** | a booted session: it verifies each condition, does the work to make failing ones true, records the clearance (`gate-approve.sh`), then implements. A person may also approve. **The default — bias here.** |
     | `manual <who/what>` | **human** | a person doing the numbered Gates steps, then approving (console Gate card, or `gate-approve.sh`) |
     | `date YYYY-MM-DD` | auto | the calendar (opens on that date) |
     | `deadline YYYY-MM-DD` / `by …` | auto | staying before the date — after it, `OVERDUE` |
     | `phase N` / `phases N,M,…` | auto | those phases of THIS plan reaching verified |
     | `plan <slug>:<phases>` | auto | those phases of ANOTHER plan reaching done |
     | `cmd <read-only command>` | auto | the command exiting 0 (executed only under `PHASE_EXEC_GATES=1` — the autopilot sets it; page views never do) |

     A `*(GATED)*` heading with **no** Gate-check reads as **human** (the safe default) — the console
     nudges you to categorize it. `scripts/phase-graph.sh <slug> --gate-status N` evaluates any of them
     (exit 0 = clear, 1 = blocked/manual/ai); `--gate-kind N` answers the category
     (`human` · `ai` · `auto` · `none`). **Approval is the one door for every kind:**
     `scripts/gate-approve.sh <slug> <N> [--by WHO] [--note TEXT]` records a clearance row in
     `docs/handoffs/<slug>/gate-status.md` that `--gate-status` honours before evaluating anything
     (`--revoke` restores the gate). Commit + push that file — a clearance only exists where it can be
     pulled.
   - **Size (optional, drives batching):** tag each phase's rough working-set in its `### Phase N` block —
     `- **Size:** S|M|L` (default `M`; `S` ≤ ~15K, `M` ~15–50K, `L` ~50–120K tokens). Then
     `scripts/phase-graph.sh <slug> --session-plan <model>` groups the remaining phases — sequential
     chains *and* independent siblings — into sessions while deps are met and the summed weight fits the
     budget (GATED phases and QA boundaries always cut), and the board prints `SUGGESTED BATCHES:`.
     Absent any `Size:` tags every phase is treated as `M`. See `references/sizing.md`.

6. **`## Phases`** — one subsection per phase, each self-contained:

   ```
   ### Phase N — <title>
   - **Goal:** what ships.
   - **Size:** S | M | L   (rough working-set; drives batching — see `references/sizing.md`).
     Optionally add `- **Model:** <alias>` if this phase wants a specific model, and
     `- **Effort:** low|medium|high|xhigh|max` if it wants a specific reasoning level. Both are
     machine-read: the Phase Console's autopilot resolves what a phase runs as from the operator's
     choice for that run, then these bullets, then the run's own defaults — **per field**, so naming
     a model here does not discard an effort, or the reverse. Write the alias anywhere in the line
     (`**Model:** Opus — the hard reasoning` parses); anything unrecognised is ignored rather than
     guessed at.
     Add `- **MCP:** \`server\`, \`server\`` when THIS phase needs servers the rest of the plan does
     not — a browser-driving phase wanting `playwright`, a triage phase wanting `sentry`. Backticked
     registry ids, same as the plan-wide line, and **unioned** with it: a phase gets the plan's
     servers plus its own. An operator can add more for one run from the console; they cannot untick
     what the plan named, because that is a statement about the work rather than a preference.
     Add `- **MCP policy:** require` (or `continue`) when THIS phase disagrees with the plan-wide
     line. Unlike `**MCP:**` this **overrides** rather than unions — a policy is one answer, and the
     more specific statement wins — so a plan-wide `require` can carve out the one phase that
     touches none of it, and a plan-wide silence can single out the one phase that must not proceed
     without its server. Anything other than those two words reads as saying nothing, which falls
     through to the plan and then to the run's own setting; only an operator's per-phase choice in
     the console outranks this bullet.
   - **Read first:** exact artifacts to load (phase 1: just this plan; later: the prior handoff + this
     plan §Phase N + memory project_<slug>).
   - **Files to create/modify:** concrete paths.
   - **Steps:** high level — the `pN.taskM` task list is built at execution time, not here.
   - **Exit criteria:** a numbered list of **specific, independently verifiable** outcomes — each one
     confirmable by reading the code or running a command (e.g. "rejects empty input with HTTP 400", not
     "input handling works"). These ARE the contract the finishing session verifies, dependents rely on,
     and — when QA is enabled — the QA subagent checks; vague criteria get held to their strongest
     reasonable reading, so make them tight.
     Mirror the one-line summary into the Phase-graph table's `Exit criteria` column.
   - **Verification:** the concrete commands/tests proving each exit criterion — runnable, not narrative.
     Every command must be WHOLE and copy-runnable: an ellipsis fragment (`… -m "not slow" -q`) is
     refused by the runner's extractor and becomes a card a person must hand-confirm — a real phase
     spent $45 and 68 minutes before its verification turned out to contain nothing runnable, which
     the console now parks on at boarding instead. Commands that depend on their directory
     (`docker compose`, `pnpm`, `npm`, `task`, `pytest`, …) need the phase's `- **Verify in:** <path>`
     bullet — a bare path on ONE line — or they run at the repository root.
     **Both of these shapes are machine-read** (the extractor sees backticked spans and fenced lines;
     prose around them is ignored; nested sub-bullets fold into the field and nested bold labels like
     a nested `**Verify in:**` stay addressable):

     ~~~
     - **Verification:**
       ```
       task audit:schema
       pytest tests/unit -q
       ```
     - **Verify in:** services/api
     ~~~

     or, equivalently, as nested bullets:

     ~~~
     - **Verification:**
       - **Verify in:** services/api
       - `task audit:schema`
       - `pytest tests/unit -q`
     ~~~

     `validate.sh` warns (F14) on any open phase whose §Verification would extract nothing runnable
     — heed it at plan time; at run time the same defect parks the phase at boarding (and, under
     keep-going autonomy, dispatches a plan-repair agent to author the bullet from the exit criteria).
     It also warns (**F16**) when a §Verification command **waits on an external clock** — `gh run
     watch`, a `task deploy` that needs a CI-built image, a `--watch`/`wait` flag, a long `sleep` —
     because the runner bounds each verification command at 30 minutes and an unattended session cannot
     outlive its turn. Prefer **splitting the phase**: a build phase whose verification proves what is
     provable now, and a verify/deploy follow-up phase behind a `- **Gate-check:** ai <condition>` (or
     `cmd <observe-only command>`) that clears once the external process lands. A phase that keeps an
     external-clock verification will **park at runtime as `waiting`** instead of failing: the session
     writes an `in-progress` handoff, declares the wait via `scripts/phase-outcome.sh … waiting-external`,
     and the runner resumes it when the window elapses — capped at 4 waits / 8 h per phase.
     **Phase-finish runs these green before handing off** (Mode 3 step 1). Add a deterministic test for
     every criterion you can; flag any that can only be reasoned about. Before relying on a CLI flag's
     semantics in one of these commands, re-check the tool's current docs and note the check in the
     handoff — a flag that changed meaning turns a green verification into a claim about nothing.
   - **Verify in:** *(optional)* the directory those commands mean, **relative to the repo root** — e.g.
     `- **Verify in:** packages/cart-api`. Omit it and they run at the root, which is right for a
     single-repo plan and wrong for a monorepo phase: `docker compose run … -v "$PWD:/app"` at the
     superproject mounts the whole monorepo. The autopilot honours this and records where it ran; a path
     that escapes the root or does not exist falls back to the root with a `phase.verify-in-missing`
     journal line. When a verification fails and the phase's Repos column names one repo that IS a
     directory near the root, the halt suggests this bullet — it never picks a directory on its own,
     because a wrongly-guessed cwd verifies the wrong tree and reports green.
   - **Handoff must record:** what Phase N+1 needs to start cold.
   ```

7. **`## End-to-end verification`** — how to test the whole feature once all phases land (run it, MCP
   checks, tests).

## Notes
- Size phases to the session budget (`references/sizing.md`): author the FEWEST phases that fit
  (≈ `ceil(total weight / budget)` plus earned boundaries — gates, model switches, user checkpoints);
  split anything that wouldn't fit one session's budget. Record the budget in `## Session budget` and tag
  phases with `Size:` so the engine can propose the session grouping.
- The plan is the only place the full roadmap lives. Handoffs link here; they never duplicate it.
- `memory:` may point to a pre-existing `project_<other>` key when this plan extends ongoing work.
  Document the override in the frontmatter comment and in a provenance blockquote under the title.
- **Exit criteria are the verification contract.** The finishing session proves them with the phase's
  §Verification commands before handing off; when QA is enabled (`**QA gate:** on` — off by default), a
  fresh-context QA subagent additionally re-verifies them and its results land in
  `docs/handoffs/<slug>/test-status.md`, gating dependents. Write criteria you
  could hand to an independent reviewer. Validate the whole plan with `scripts/validate.sh <slug>` before
  trusting the board (it flags malformed rows, undefined deps, cycles, and inconsistent handoffs).
- Scaffold with `scripts/new-plan.sh <slug>`; the literal template is `templates/plan.md`.
