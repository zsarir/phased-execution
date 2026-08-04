# QA gating

QA here is not a report you read afterwards. It is a **gate**: with it on, a phase's dependents are
not allowed to start until that phase is verified. That is the whole point — a broken phase should not
silently propagate into everything built on top of it.

```mermaid
flowchart LR
    A["phase 4<br/>finishes"] --> B["fresh QA subagent<br/>clean context, reads the real diff"]
    B --> P["pass / waived"]
    B --> F["fail"]
    P --> R["dependents become ready"]
    F --> H["dependents stay blocked<br/>until a re-QA passes"]

    class A finish
    class B qa
    class P,R ok
    class F,H bad

    classDef finish fill:#4FA8FF,stroke:#2B7BC9,color:#04131F
    classDef qa fill:#C77DFF,stroke:#9147C4,color:#1B0A26
    classDef ok fill:#3FB68B,stroke:#248063,color:#06251A
    classDef bad fill:#FF5D5D,stroke:#C43A3A,color:#2A0505
```

**Turning it on.** Ask for it at plan time and the plan records `**QA gate:** on`. Ask for it later
and the next phase-finish picks it up. Check which regime a plan is in:

```bash
scripts/phase-graph.sh checkout-rewrite --qa-mode      # off | on <reason> | waived <reason>
```

**Why a *fresh* subagent.** The session that built the phase shares the blind spots of the code it
just wrote. QA runs in a subagent with a clean context that reads the real diff cold — it verifies
commits against `git show` rather than trusting the handoff's summary, checks every exit criterion,
sweeps for correctness, edge cases, error handling, regressions and security, and runs the tests. A
suite that is green but does not actually cover the criteria is a **fail**, not a pass.

**The verdicts.**

| Verdict | Meaning | Effect on dependents |
|---|---|---|
| `pass` | every exit criterion met with evidence, tests green, no high/critical findings | released |
| `fail` | a criterion unmet, a high/critical finding, or red tests | **held** until a re-QA passes |
| `waived` | genuinely not applicable, justified explicitly | released |
| `pending` | recorded but not yet judged | held |

On a fail, the QA subagent does **not** fix the code — it returns the verdict and enumerates the
follow-ups. The finishing session owns the fix, and re-QA is always a *new* fresh subagent, never a
re-run inside the one that failed. Results are committed and pushed so the gate reaches every clone.

Verdicts are recorded only through `scripts/qa-record.sh` — an idempotent upsert. Never hand-edit
`test-status.md`.

---

