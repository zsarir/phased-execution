# Model handling

Everything about sizing flows from the model you are running.

| Model | Window | Session budget *(phase weight)* | Best used for |
|---|---|---|---|
| **Opus** 4.8 / 4.7 / 4.6 | 1M | **~200K** | the default executor; hard reasoning and architecture |
| **Fable 5** | 1M | **~200K** | planning, and the most demanding long-horizon phases |
| **Sonnet** 5 / 4.6 | 1M | **~200K** | balanced implementation phases |
| **Haiku 4.5** | 200K | **~40K** | mechanical, cheap phases — so: smaller phases, more of them |
| *unknown / unspecified* | — | **~40K** | assumes a 200K effective window |

These numbers live in one place, [`scripts/sizing.env`](../scripts/sizing.env), which the engine reads
directly — so the docs and the tool cannot drift apart. Edit that file to change them globally.

**Why weight, and why 0.2×.** A phase's weight estimates the working set its work adds — bootstrap
reads, files opened, tool output, diffs. Real session context runs about **3× the summed weight**
once the system prompt, thinking, tool chatter and conversation overhead sit on top. So a ~200K budget
lands near ~600K of real context on a 1M model: about 60% utilisation. Filling the window to 100% is a
trap for exactly this reason — the weights under-count reality threefold.

> ⚠️ **Check your *effective* window, not the model's maximum.** A session can be configured with a
> 200K window even on a 1M-capable model. Budget ≈ 0.2 × the window you actually have.

**Per-phase model choice is a lever too.** Hard reasoning on Opus or Fable, balanced implementation on
Sonnet, rename sweeps and boilerplate on Haiku. One caveat: switching models mid-session throws away
the prompt cache, so keep one model per session — a wanted model switch is one of the few things that
*earns* a session boundary.

**Keeping a session lean** stretches the budget: push broad code search and multi-file exploration
into subagents that read a lot and return a short summary, so those tokens never enter the phase
session. Do not over-delegate — a single file read is faster done directly.

---

