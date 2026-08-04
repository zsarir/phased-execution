# The artifacts

Four files, one job each. They never duplicate each other, and the same `<slug>` ties them together
so one search finds all of them.

```mermaid
flowchart LR
    subgraph repo["committed in YOUR repository"]
      direction TB
      PLAN["docs/plans/your-plan.md<br/>THE ROADMAP<br/>every phase, the graph, the budget"]
      HAND["docs/handoffs/your-plan/<br/>THE BATON<br/>phase-NN-*.md + INDEX.md"]
      QA["docs/handoffs/your-plan/test-status.md<br/>QA VERDICTS — optional"]
    end
    MEM["memory: project_your-plan<br/>DURABLE FACTS<br/>status, commits, gotchas"]

    PLAN --> S["a fresh session,<br/>zero prior context"]
    HAND --> S
    QA --> S
    MEM --> S

    class PLAN plan
    class HAND hand
    class QA qa
    class MEM mem
    class S sess

    classDef plan fill:#4FA8FF,stroke:#2B7BC9,color:#04131F
    classDef hand fill:#3FB68B,stroke:#248063,color:#06251A
    classDef qa fill:#C77DFF,stroke:#9147C4,color:#1B0A26
    classDef mem fill:#FFB627,stroke:#B8790C,color:#2A1C00
    classDef sess fill:#152730,stroke:#3A5560,color:#E6EDF0,stroke-width:2px
```

| Artifact | Where | Its one job |
|---|---|---|
| **Plan** | `docs/plans/<slug>.md` | The durable roadmap: every phase, the dependency graph, per-phase detail, exit criteria. Written once, rarely edited. |
| **Handoff** | `docs/handoffs/<slug>/phase-NN-*.md` + `INDEX.md` | The baton for the *next* cold session: state now, files changed, decisions, exact next commands. Written at the end of every phase. |
| **Memory** | `project_<slug>` in your memory index | Durable cross-session facts — status as a *set*, commit shas, gates, gotchas. |
| **QA status** *(opt-in)* | `docs/handoffs/<slug>/test-status.md` + `reports/` | Per-phase verdicts that **gate dependents**. Does not exist unless you turn QA on. |

Plans and handoffs live in **your project repo**, committed and pushed — so any machine or account can
pull and continue. The skill itself stays separate; work-state never goes in the skill folder.

---

