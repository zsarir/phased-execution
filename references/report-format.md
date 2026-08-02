# QA report format

One report per phase at `docs/handoffs/<slug>/reports/phase-NN-qa.md`, from
`assets/report-template.md`. It must let a reader (human or a future session) trust the verdict without
re-doing the review — so every claim carries evidence (file:line, sha, test output).

Required sections (see the template):

1. **Header** — slug, phase, title, **result** (pass|fail|waived), date, handoff link, commits reviewed.
2. **Exit criteria — verdict** — a row per criterion from plan §Phase N: met / not-met / unverifiable +
   evidence. This is the spine of the report.
3. **Code review findings** — each gap/bug/regression with severity (Critical/High/Medium/Low) and
   file:line. "No findings" is a valid, explicit entry.
4. **Tests** — what was run and added; pass/fail counts; which exit criteria are covered by deterministic
   checks vs reasoned-only.
5. **Verdict & required follow-ups** — the overall call, and if fail, the exact list of what must change
   before dependents start.

The `qa-full` report uses the same shape but at plan scope: end-to-end verification results, a per-phase
status roll-up, and any regression discovered across the finished plan.
