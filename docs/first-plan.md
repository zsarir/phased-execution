# Your first plan, step by step

Nothing here is ceremony you perform by hand. You talk to Claude; the skill drives the procedure.
This is what actually happens, so you can recognise it.

## Step 1 — Ask for it

In your project, tell Claude what you want built, and that it should be phased:

```
/phased-execution

I want to rewrite checkout: new schema, a pricing service, a payment adapter,
webhook ingest, cart API, refunds, the UI, receipts, and a ship step.
```

You can also just describe big work — the skill announces itself when it fits.

## Step 2 — Answer one question about the model

Claude asks which model will *execute* the phases, because that decides how big each session may be.
If you do not care, say so and it uses a sensible default. See
[Model handling](model-handling.md) for what changes.

## Step 3 — Claude writes the plan

It creates `docs/plans/checkout-rewrite.md` in **your** repository, containing:

- why the work exists and the key design decisions
- a **`## Session budget`** note: target model, per-session budget, branch, and any options you asked for
- a **`## Phase graph`** table — this is the machine-read part, one row per phase with its dependencies
- one self-contained section per phase: goal, size, files, steps, **exit criteria**, **verification commands**
- an end-to-end verification section for when it is all done

Then it checks its own work:

```bash
scripts/phase-graph.sh checkout-rewrite        # does the board look right?
scripts/validate.sh checkout-rewrite           # malformed rows? undefined deps? cycles?
```

Read the plan. **This is your main point of control** — it is a normal markdown file, and editing it
changes what happens next. Everything in [What you control](controls.md) is a line in this file.

## Step 4 — Claude commits the plan and starts building

The same session then implements Phase 1 — no cold restart between planning and starting, because the
context is already warm.

## Step 5 — At the end of each phase

Claude runs a fixed checklist, in this order, and the order matters:

1. **Verify** — run that phase's own verification commands. All green, or the phase is handed off as
   `blocked`. A red phase is never handed off as complete.
2. **Commit** — explicit file paths, never `git add -A`.
3. **Write the handoff** — `docs/handoffs/checkout-rewrite/phase-01-schema.md`: what changed, which
   files, which decisions, what the next session needs. This is what makes a cold start possible.
4. **Update memory** — the durable facts that must outlive the docs.
5. **Decide: continue, or stop.**

## Step 6 — Continue or stop

If the next ready phase fits the **remaining** session budget, Claude just continues into it — same
session, warm cache, no bootstrap. That is the efficient default.

If the budget is spent (or the next phase is gated, or wants a different model), it stops and prints a
**boot prompt**: a copy-pasteable block that boots the next phase in a brand-new session with zero
prior context. You open a fresh session, paste it, and work resumes exactly where it left off.

```
────────────────── START COPY ──────────────────
Continue plan `checkout-rewrite` — Phase 5 (Cart API).
Read docs/plans/checkout-rewrite.md §Phase 5 and
docs/handoffs/checkout-rewrite/phase-02-pricing.md first.
...
─────────────────── END COPY ───────────────────
```

## Step 7 — Check on it any time

```bash
scripts/phase-graph.sh checkout-rewrite      # the board
phase-console                                # or the whole thing in a browser
```

---

