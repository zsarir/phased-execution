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
status: active              # active | complete | abandoned
phases: <N>                 # total phase count
handoffs: docs/handoffs/<slug>/
memory: project_<slug>      # or pre-existing project_<other> when reusing an existing memory
---
```

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
   line listing them, **backticked** (e.g. `` `frontend-design` ``). The engine reads that line and
   re-injects those skills into **every** phase's boot prompt (and the QA brief), so each cold-start session
   re-invokes them rather than forgetting them.
   **QA is off by default** — add a line with exactly `**QA gate:** on` ONLY when the user asked for QA on
   this work (then every phase-finish dispatches a fresh-context QA subagent); `**QA gate:** off` records
   an explicit waiver (rows written as `waived`, no subagents). Only that exact bolded form is
   machine-read (`phase-graph.sh --qa-mode`). See `references/sizing.md` for sizing and
   `references/conventions.md` §Branches for the branch policy. Example:
   > **Target model:** `claude-opus-4-8` (1M window) · **Budget:** ~200K weight/session (≈60% of the window) · **Branch:** current branch (no new branch).
   > **Skills (every session):** `frontend-design`, `superpowers:test-driven-development`
   > Hard-reasoning phases → Opus/Fable; mechanical phases → Haiku if run in their own sessions.
5. **`## Phase graph`** — a table that makes blocking vs parallel obvious. **This table is machine-read:**
   `scripts/phase-graph.sh` parses the `Depends on` column to compute live readiness, so keep it exact.

   | Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
   |------:|-------|-----------|--------------------|-------|---------------|

   Follow the table with an explicit callout:
   - **Blocking:** `1 → 2 → 4` (linear chains)
   - **Independent (run in any order, one at a time):** `3a ∥ 3b` (same dependencies, no shared files)

   Dependency rules + parse format:
   - A phase lists **every** phase that must complete first in `Depends on`. Two phases are *parallel-safe*
     only if neither depends on the other **and** they don't edit the same files.
   - The `Depends on` cell accepts: a single number (`4`), a comma list (`4, 5`), a **range** (`1–7`,
     en-dash or hyphen, expands to 1…7), combinations (`1–7 (+8–10)`), or `—` for no dependencies. The
     parser keeps digits + range dashes and ignores other punctuation, so prose-y cells still parse.
   - The phase number lives in column 1; **markdown-bold cells (`| **6** |`) are tolerated**, but don't put
     a phase's number anywhere the parser could mistake it. After writing, run `scripts/phase-graph.sh
     <slug>` and confirm the parsed phase count matches the frontmatter `phases:` (it warns on mismatch).
   - **Gated phases:** mark `*(GATED)*` in the `### Phase N` heading and add a
     `- **Gates (must clear first):** …` line (prose, surfaced in every boot prompt). For a
     **machine-checkable** gate, also add `- **Gate-check:** <type> <value>` — `date YYYY-MM-DD` (opens on
     that date), `phase N` (clears when phase N is verified), or `manual <text>` (needs human sign-off).
     `scripts/phase-graph.sh <slug> --gate-status N` evaluates it (exit 0 = clear, 1 = blocked/manual).
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
     Optionally add `- **Model:** <alias>` if this phase wants a specific model.
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
     **Phase-finish runs these green before handing off** (Mode 3 step 1). Add a deterministic test for
     every criterion you can; flag any that can only be reasoned about.
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
