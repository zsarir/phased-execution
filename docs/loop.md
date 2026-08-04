# The loop

Three modes. You never name them; Claude picks the one that matches the situation and says which it
is using.

```mermaid
flowchart TD
    A["Mode 1 · plan<br/>author the graph, size it to the model"] --> B["Mode 2 · phase-start<br/>bootstrap from disk, claim the phase lock"]
    B --> C["Mode 3 · phase-finish<br/>verify → commit → handoff → memory"]
    C --> D{"does the next ready phase<br/>fit the remaining budget?"}
    D -->|"yes — batch it"| B
    D -->|"no · gated · wants another model"| E["stop, print the boot prompt"]
    E -.->|"you paste it into a fresh session"| B

    class A plan
    class B start
    class C finish
    class D q
    class E stop

    classDef plan fill:#4FA8FF,stroke:#2B7BC9,color:#04131F,stroke-width:2px
    classDef start fill:#FFB627,stroke:#B8790C,color:#2A1C00,stroke-width:2px
    classDef finish fill:#3FB68B,stroke:#248063,color:#06251A,stroke-width:2px
    classDef q fill:#152730,stroke:#3A5560,color:#E6EDF0,stroke-width:1px
    classDef stop fill:#C77DFF,stroke:#9147C4,color:#1B0A26,stroke-width:2px
```

The important property: **Mode 2 bootstraps from disk only.** A fresh session reads the plan, the
dependency handoffs and the memory entry — and that has to be enough. If it is not, the previous
handoff was deficient, and *that* is the bug to fix.

---

