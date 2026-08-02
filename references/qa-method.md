# QA method — how to verify a phase

> **QA is opt-in (off by default since v3).** This discipline runs only when the plan enables QA —
> `**QA gate:** on` in §Session budget, `new-handoff.sh --qa` at a finish, or a plan that already has a
> `test-status.md`. Check with `scripts/phase-graph.sh <slug> --qa-mode`: `waived` means record rows
> without dispatching anyone; `off` means none of this file applies — the finishing session's own
> §Verification run is the quality bar.

The goal is a trustworthy **pass/fail** verdict, reached by independent reasoning about the real code,
not by re-running the builder's own happy-path tests. Hold the work to the strongest reasonable reading
of its exit criteria — dependents will build on whatever you wave through.

## 1. Establish the real diff (don't trust the summary)

The handoff's "What this phase did" is the author's claim. Verify it against ground truth:

- **Commits:** read the shas the handoff records and `git show`/`git diff` them. Cross-check with
  `git log --oneline` for the phase's window. If the handoff claims something is committed, confirm it
  is (stale "uncommitted/committed" claims are the #1 handoff defect).
- **Files:** read every path in the handoff `key_files`, plus anything the diff touches that the handoff
  *didn't* mention (omissions are findings too).
- Restate, in your own words, what actually changed and why. If you can't, you haven't read enough.

**Large diffs:** dispatch parallel `Agent` subagents to read slices (by file/subsystem) and return
findings with file:line evidence. You synthesize and own the verdict — never delegate the judgment.

## 2. Investigate the implementation

For each exit criterion in plan §Phase N, decide met / not-met / unverifiable, with evidence. Then sweep
the changed code for:

| Lens | Looking for |
|------|-------------|
| Correctness | logic errors, off-by-one, wrong defaults, mishandled nulls/empties |
| Edge cases | boundaries, empty input, concurrency, retries, partial failure |
| Error handling | swallowed errors, missing validation, silent fallbacks |
| Regressions | broken contracts a sibling phase depends on; changed shared files |
| Security | injection, secrets in code/logs, authz gaps, unsafe deserialization |
| Tests | do the phase's tests actually exercise the criteria, or pass vacuously? |

A test suite that's green but doesn't cover the criteria is a **fail**, not a pass.

## 3. Severity rubric

- **Critical** — data loss, security hole, or the phase's main goal doesn't work. → fail.
- **High** — an exit criterion unmet, or a bug that will bite a dependent phase. → fail.
- **Medium** — real but non-blocking (degraded edge case, weak test). → note; pass allowed if criteria met.
- **Low** — style, minor nit. → note.

## 4. Tests: run, then extend

Run the phase's tests and the project suite; capture pass/fail counts and any flakiness. For every exit
criterion lacking a deterministic check, **write one and run it** (prefer the project's existing test
framework). When a criterion genuinely can't be automated, verify it by reasoning and label it
"reasoned, not automated" in the report. Deterministic checks beat narrative every time.

## 5. Verdict discipline

- **pass** only when: every exit criterion met (with evidence), tests green, no High/Critical findings.
- **fail** when: any criterion unmet, any High/Critical finding, or red/missing tests. Enumerate the
  exact follow-ups required before a re-QA.
- **waived** only for a criterion that is genuinely not applicable — justify it explicitly.

Bias toward fail when uncertain: a false pass lets a broken base propagate to every dependent.

## 6. Record + hand back

Write the report (`assets/report-template.md`) to `docs/handoffs/<slug>/reports/phase-NN-qa.md`, then
record the result with `scripts/qa-record.sh` (never hand-edit test-status.md). Commit + push the report
and test-status.md (shared work-state in the project repo). On pass, show the engine board so the newly
unblocked phases are visible; on fail, restate what must change.

**On fail.** Record `fail`, commit + push the report + test-status.md (the gate must reach every clone), and
enumerate the exact required follow-ups in the report. You return the verdict; you do **not** fix the code —
the finishing session owns the fix. Re-QA is always a **new** fresh-context subagent, never a re-run in this
context: after the builder re-commits, a fresh subagent re-reads the new diff cold (`qa-record.sh` overwrites
the row `fail`→`pass`). If the builder can't fix immediately, the phase's handoff is set `status: blocked`,
which the engine reads as `stuck` — that holds dependents independently of the QA row until a later session
fixes it and re-QAs to `pass`.

## 7. Engine sub-commands the QA step uses

The QA subagent's brief comes from `scripts/phase-graph.sh <slug> --qa-prompt <N>`. These read-only engine
commands help while reviewing (run from the project root that owns `docs/`, or set `DOCS_ROOT`):

| Command | Use |
|---------|-----|
| `<slug>` | human board: done/ready/waiting + QA markers (QA:verified / FAILED / pending) |
| `<slug> --qa-result N` | the recorded QA result for phase N |
| `<slug> --gate-status N` | evaluate N's machine gate (clear / blocked / manual; exit 0/1) |
| `<slug> --memory-block` | the canonical done/ready/waiting block (handy for the qa-full roll-up) |
| `<slug> --deps N` / `--dependents N` | N's prerequisites / the phases N blocks |

Record results **only** via `scripts/qa-record.sh <slug> <N> <pass|fail|waived> --report reports/phase-NN-qa.md`
— an idempotent upsert into `test-status.md` (its existence turns on QA gating in the engine). Never
hand-edit the table.
