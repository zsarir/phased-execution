# QA report — Phase {{PHASE}}: {{TITLE}} ({{SLUG}})

- **Result:** {{RESULT}}            <!-- pass | fail | waived -->
- **Date:** {{DATE}}
- **Reviewed by:** phased-execution (QA subagent)
- **Handoff:** docs/handoffs/{{SLUG}}/phase-{{PAD}}-{{TITLE}}.md
- **Commits reviewed:** {{COMMITS}}

## Exit criteria — verdict

| # | Exit criterion (from plan §Phase {{PHASE}}) | Met? | Evidence |
|--:|----------------------------------------------|------|----------|
| 1 |  | met / not-met / unverifiable | file:line, sha, or test output |

## Code review findings

<!-- One row per finding; "No findings." is a valid explicit entry. -->

| Severity | Finding | Location | Required fix |
|----------|---------|----------|--------------|
| High/Med/Low | | file:line | |

## Tests

- Ran: <command(s)> → <pass>/<total> (note any flakiness)
- Added: <new tests covering which exit criteria>
- Coverage: criteria checked deterministically vs reasoned-only

## Verdict & required follow-ups

<!-- Overall pass/fail. If fail: the exact list of changes required before a re-QA;
     dependents remain gated until then. If pass: dependents are now unblocked. -->
