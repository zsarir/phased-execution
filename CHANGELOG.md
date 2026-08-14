# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the npm/Homebrew release
tags (`vX.Y.Z`), published by CI from the tag. The Claude Code **plugin** channel is deliberately
versionless — it tracks every commit to `main` — and `SKILL.md`'s own `metadata.version` tracks
skill content, independent of these package releases.

## [2.2.1] - 2026-08-15

2.2.0's release run died at the gates on a machine-dependent test (an F17 assertion that only held
where `pnpm` happened to be installed), so nothing reached npm or Homebrew — this release carries
everything 2.2.0 promised, plus the day's second wave:

- **Pulse** — a live heartbeat panel. The plan's route tab now leads with which phases are being
  worked on *this second*, in what vehicle (autopilot lane, frozen lane), on what model, with a
  ticking elapsed clock and cost per lane; below it, what is queued behind a lock (and since when),
  what is parked waiting on the outside world (reason, wake-up countdown, watch refs), and what the
  board says is up next behind which dependency. The new **`#/pulse`** page shows the same panel for
  every plan at once, live-first — the whole console's "is anything moving, is anything stuck
  waiting for me" on one phone-sized page.
- **Recover & continue** — one button per stopped plan. Three honest steps, reported by name: re-read
  the board and stand down whatever it has already settled (the observed phase-7 shape: halted on
  the banner, done on the list), continue a run that has nothing wrong, and for a real halt arm
  bounded auto-recovery through the SAME healer the unattended path uses — never a second
  orchestration. What only a person can settle comes back named instead of blindly retried.
- **A resolved stop stops shouting.** A run the board has overtaken now says "Stopped — resolved on
  its own" (info, with the resolution's words) instead of re-crying a dead halt, and offers no
  recovery buttons — settled questions are not relitigated.
- **Failed verification commands run from the page.** Each failed or skipped §Verification command
  on the run page grew a "run in your terminal" button: the exact recorded command (nothing else is
  accepted — a page must never become a shell) opens in the integrated terminal, in the phase's own
  directory, in *your* login shell with your aliases; the exit lands back on the phase record,
  journalled and announced, and an all-green result triggers the normal re-check that closes the
  phase.
- **The phone terminal actually works.** The key bar's Esc/Tab/Ctrl/arrows were dead under a finger
  (the same `preventDefault` that keeps the iOS keyboard up also cancels the synthetic click — keys
  now fire from `touchend`); vertical swipes scroll the scrollback (xterm's viewport is a scroll
  proxy a finger can never reach, so the pane converts vertical drags to `scrollLines` itself); and
  the terminal keeps a minimum of 80 columns on a phone with the host scrolling sideways, instead of
  wrapping every TUI into confetti.
- Launchd PATH hygiene: `agent.sh install` now drops dead directories and other users' homes before
  baking the unit, `status` audits the installed plist, and a re-install from a fresh terminal no
  longer loses `PHASE_CONSOLE_DEFAULT_SKILLS`/`PHASE_CONSOLE_NOTIFY` previously set only in the
  unit's environment.

## [2.2.0] - 2026-08-15

Recovery grew organically into two systems both called "recovery" — a fresh briefed agent
("Fix with AI") and the runner's resume-of-the-phase's-own-session verbs — five word-books, four
different menus on one page, and a concurrency hole letting both edit one tree at once. One shared
model now decides every offer (`viewer/shared/recovery-model.js`), and one component renders it as
**Ways forward** on every surface: halt banner, phase diagnosis (the agent path appears there at
last), next-steps, dashboard, route cards, the fleet (which listed every stopped run and offered no
recovery at all), stats, the phase page and Ready. Every button names its mechanism — *own session*
(cheap, context intact) vs *new agent* (fresh eyes, costs a session) — and carries exactly what will
happen as a tooltip on desktop and a tappable ⓘ on touch. Parked runs finally raise dashboard cards
(an MCP-parked plan once sat 85 minutes with its one-button remedy unreachable), the run-verbs
refuse with a link while an agent recovery holds the phase, and a recovery that finds nothing wrong
now says so as the good news it is.

The dominant real-world failure — 16 verify-failed halts, 15 of them spurious, every one predicted
by the preflight and run anyway — can no longer happen: a §Verification command whose lead binary
this machine lacks (`rg` as a shell function elsewhere, `python` meaning python3) is **skipped and
recorded**, never run to a 127 halt; a phase whose every check is skipped parks at boarding; and two
new plan-time warnings land the same facts while the author is still at the keyboard (**F17**
missing lead, **F18** cwd-sensitive command with no `Verify in:` — `scripts/verify.env` is their
shared single source). A phase that declared itself `blocked` halts as `phase-blocked` instead of
"no handoff was written" (twelve real halts, four looping closeout sessions), every halt site now
writes a typed kind, read-only `gh` and `docker compose config` pass the verification allowlist,
and `PE_MCP_SERVERS` reaches every session and pty so the F15 MCP advisory fires in production.
A halt the board has already moved past **retracts** its urgent notification (same push tag, quiet);
repeated push rejections (`BadJwtToken` — a measured 29-send outage) surface on a new environment
card beside launchd PATH rot the doctor now audits (`agent.sh status` names dead directories and
foreign homes); `GET /api/plans/:slug/verify-preflight` serves boarding's findings before any money
is spent; and a test process that resolves the operator's real state directory now throws (3,553
leaked tmpdirs cleaned up).

The console is usable one-thumb. The software keyboard no longer hides what you type
(`interactive-widget=resizes-content` + a visualViewport-driven `--app-height`; the tab bar steps
aside while a field has focus); the one page scroller resets on navigation; the 16px input floor
finally beats `text-xs` (the ask-box zoomed iOS and left it zoomed); the live console and skill
picker stop eating flicks at their ends; terminal and agent are true full-height routes (banners
squeeze the frame instead of pushing the KeyBar under the keyboard), with a contained scrollback, a
jump-to-Latest button and a font size that follows the breakpoint live; the fleet and the plan's
Route tab render as cards on a phone; dialogs stop measuring by `100vw`; and the route map sizes by
`dvh`. Boot prompts and the Stop hook now lead with the `waiting-external` declaration (used once in
$3k of runs while dozens of sessions ended "waiting on the build" in prose).

## [2.1.0] - 2026-08-11

An MCP server that will not connect stops being able to stop a plan. A run of an eleven-phase plan
was started on autopilot and halted three minutes and forty-two seconds later having run **nothing**,
0 phases done. Its journal is the whole story: phases 1, 4 and 7 queued correctly behind another
plan's `scope=all` lock, waited 3m37s, and were admitted the moment the lease expired — the lock
orchestration worked exactly as designed. Two seconds later all three parked, because `grafana` and
`sentry` had never been signed in and `filesystem` had been added from the catalog with its
`${MCP_FS_ROOT}` never filled in. The plan named no MCP servers at all.

The park was right about the phase that genuinely cannot work without its server and wrong about
every phase that merely has one attached — and since `parked` is a settled status, a run whose ready
phases have all parked has no candidates left and halts. Worse, the park was a dead end: it set no
`halt.kind`, so no recovery could reach it, and the remedy list had no MCP entry, so the halt named
the problem and then stopped talking. The self-heal that was supposed to requeue on sign-in fired on
exactly one trigger — a `claude mcp login` terminal exiting — which a permanently-misconfigured
server can never produce.

### Added

- **`mcpPolicy` — `continue` (the new default) or `require`.** Under `continue` a phase boards
  without the servers that would not answer: they are dropped from its `--mcp-config`, its prompt
  names them with the reason and instructs it neither to improvise a substitute nor to treat them as
  a blocker — do the work that does not depend on them, and record the rest under **Outstanding** as
  an operator errand — the degradation is written to the phase record, and the operator is told once
  per run per server. `require` is the old park.
- **Four levels, resolved most-specific-first**: the operator's per-phase choice, then the PLAN (a
  per-phase `- **MCP policy:**` bullet, then `**MCP policy:**` in §Session budget), then the run,
  then `continue`. **The plan outranking the run is deliberate and is the one resolution in the
  runner where that ordering reverses** — `model` and `effort` let a run's choice win because they
  are preferences about spending; a phase whose plan says it requires a server is making a claim
  about the work. Settings ▸ Automation, the launch dialog, the run controls and the phase matrix
  each set their own level; `phase-graph.sh --mcp-policy [N]` and `parse/plan.ts` read the plan's,
  held together by `engine-parity`. At plan level both words are recognised and anything else is
  silence — a third state, and load-bearing: an explicit `continue` is how one phase carves itself
  out of a plan-wide `require`, and silence is what lets the run's own setting answer at all.
- **A door on every park that stops a run.** An all-MCP park now carries `kind: 'mcp-preflight'` and
  a remedy naming both ways out, and the halt card grows **Continue without these servers** — one
  button behind a new `mcp-continue` verb that sets the run to `continue` and retries exactly the
  phases the MCP preflight parked. The lock-wait cap gets its own remedy line for the same reason.
- **`needsConfig`** on a server view: `${VAR}` references in a server's own command that nothing
  supplies. The catalog's filesystem entry ships as `… server-filesystem ${MCP_FS_ROOT}` with a note
  asking for a value, and an unset one expands to nothing, so the server starts without a root and
  probes `failed` forever. It reads as a flaky remote; it is an unfinished registration, and it is
  now named as one, refused by the picker, and reported as `MCP_FS_ROOT is not set` rather than
  "will not connect".

### Changed

- **The self-heal fires on the events that actually happen.** Any transition into `connected` heals
  parks waiting on that server — not only a login terminal exiting — and so do disabling and removing
  one, because in all three cases the reason the phase parked has gone. It reaches runs that have
  already halted, which is the case that motivated it.
- **The MCP picker distinguishes "not checked" from "connected".** A server nobody has probed reports
  `unknown`, and `usable()` refused only `needs-auth` and `failed` — so all six servers looked
  ordinary in the launch dialog and three turned out to be walls at boarding, which is the exact
  failure this control's own header says it exists to prevent.
- **One preflight answer instead of one per problem.** An unresolvable id used to short-circuit
  before the probe, so a phase naming one ghost and one signed-out server reported the ghost and
  learned about the sign-in only after somebody fixed the first.
- **A scoped run whose phase parked no longer reports itself finished.** `SETTLED` includes `parked`,
  `gated` and `failed`, so "this run was scoped to phase 1, and it is settled" was true of the status
  field and false about the world — and it hid the park's own explanation entirely.
- **A lock-cap park stops its own clock.** `lockWaitSince` was cleared only after a successful claim,
  so a Retry after the two-hour cap re-derived the wait from the original timestamp and re-parked
  instantly. Retry now means the wait starts over. `Runner.retry` also clears `preflight` and
  `mcpDegraded`, which the service's stored-run Retry had always done and the live one had not.
- **`export PATH=…` is a preamble, not a check.** A plan that prefixes its node commands the way its
  §Session budget says to had every phase report "a person will be asked: export PATH=… — `export` is
  not a recognised command". It is now handled like the existing `cd` carve-out: dropped from the
  runnable commands AND from the human-check list, without swallowing a command sharing its line, and
  a §Verification holding nothing but a preamble still reads as unverified so F14 keeps warning.
- **F15 names the consequence the resolved policy actually produces**, rather than promising a park
  that no longer happens by default.

## [2.0.0] - 2026-08-10

The autopilot learns to wait, to look, and to resume. A live plan's phase 8 did 47 minutes of real
work, ended its turn "waiting on the image build (34–65 min)" in free prose, and the runner — with
no vocabulary for that — read the clean exit as completion, found no handoff, nudged once into the
same holding pattern, and halted. Across 14 real runs, "ended cleanly, no handoff" was the largest
halt class, recoveries launched seconds after the board had already superseded them, eight of eleven
phase records contradicted the board, and a foreign lock at boarding parked a phase forever. Every
one of those is now a designed state instead of a failure.

### Added

- **The phase-outcome protocol** (`scripts/phase-outcome.sh` + `viewer/server/runner/outcome.ts`):
  a session declares how it ended — `complete`, `waiting-external` (with a window and watch refs),
  `blocked`, `needs-human` — as one atomic JSON file at the runner-injected `PE_OUTCOME_FILE`, read
  once on exit, journalled, consumed, and staleness-guarded twice. Prose stops being the channel.
- **`waiting` — the external-wait park.** A `waiting-external` outcome parks the phase (lane, grant
  and lock released), the run sleeps on the soonest `parkedUntil` restart-safely, and the resume is
  the phase's **own session** (`claude -p --resume`) told the window elapsed. Caps make it honest:
  4 waits / 8 h per phase, then a `waiting-external-timeout` halt naming the watch refs.
- **The unattended-session contract**, appended by the runner to every boot, closeout and
  wait-resume prompt: the deliverable is the handoff; `ScheduleWakeup`/`Monitor`/backgrounded
  watchers do not survive a `-p` turn ending; external waits, locks and needed humans are declared
  via `phase-outcome.sh`, never waited out silently. The engine's own boot prompt now names the
  deliverable too (`new-handoff.sh` argv, the handoff path, "the board reads `status:` from it")
  instead of the six words "Stop + hand off when done."
- **A Stop hook** beside the PreToolUse hook (same origin, token, fail-open philosophy): a session
  ending with neither a handoff on the board nor a declared outcome is told exactly what to do
  instead — at most twice per session; the runner's exit-time check stays the load-bearing layer.
- **F16 lint advisory** (same warning arm as F14/F15): a §Verification command that waits on an
  external clock — `gh run watch`, `task deploy`, `--watch`/`wait`, long sleeps — with the advice to
  split the phase behind a Gate-check or expect the runtime park.
- **Live-loop reconciliation.** The docs watcher pokes running drive loops (a manual session's
  handoff is seen NOW, not when a lane settles hours later), and a reconcile pass at every tick
  closes records the board has overtaken ("closed outside this run"), dissolving halts anchored to
  them — closing only, never re-running a failed phase. The read path does the same for stopped
  runs, so "Departed" board chips over red records correct themselves.
- **Cross-plan lock orchestration.** A foreign unexpired lock queues the phase behind the named
  holder (lease end on the queue page) instead of parking it terminally; the queue wakes on lock
  churn under `docs/handoffs/**/.locks`, on a timer at the soonest blocking lease expiry, and on the
  idle poll; a 2-hour cap turns an endless wait into an honest park. The runner keepalives its
  lane's lock every 10 minutes under the shared `PE_OWNER` — a 47-minute phase can no longer
  silently lose its 30-minute lease — and stands down on a foreign takeover.
- **SKILL.md and references**: the external-waits discipline (in-progress handoff as the durable
  pause + the outcome declaration), unattended alternates for every "stop and ask" step, and
  plan-format guidance to split build ∥ verify-later behind a Gate-check.

### Changed

- **Recovery is resolve-first and session-API-first.** Before anything launches, the board is
  re-read and reconciled — a superseded halt spawns nothing (the observed
  launched-19-seconds-after-resolved class is dead). For `no-handoff`, `verify-failed` and
  `waiting-external-timeout` halts with a resumable session, auto-recovery resumes the phase's own
  session through the runner — settings, deny rules, hooks and journal all applying — under
  `--allow-run` alone. The pty agent remains for plan-shaped repairs (`--allow-agent`) and as the
  manual fallback; the halt card's primary action is now "Resume session & finish closeout".
- **Recovery verdicts got honest.** "Found nothing wrong" is `no-defect` (halt stood down, nothing
  invented `done`) instead of a failure that cleared nothing; a recovery finishing under a live
  loop hands its verdict to the loop (`enqueueResolution`) instead of being skipped; `recover()` no
  longer erases the halt before doing any work — success, and only success, retires it.
- **`saveRun` is durable**: fsync on the checkpoint before the rename and best-effort on the
  directory after.
- **Engine fallback constants** in `phase-graph.sh` now match `scripts/sizing.env`; the runner's own
  engine calls carry `PE_MCP_SERVERS`, so its `validate.sh` reads warn like the service's.

## [1.9.0] - 2026-08-09

MCP servers become something a plan can ask for and a console can prove. A phase whose GitHub
server was never signed in used to spend an hour discovering that — an unattended `claude -p` has
no `/mcp` panel, so the CLI reports the missing tools to the *model*, which improvises around them
and hands back work that used none of what was chosen for it. Now the plan names the servers, the
console holds them, and the phase parks before it is paid for.

### Added

- **MCP servers in the plan format.** `**MCP servers (every session):**` in §Session budget and a
  per-phase `- **MCP:**` bullet, unioned — a phase runs with the plan's servers plus its own.
  Backticked *registry ids*: what the phase needs, never how to reach it. Read by both parsers
  (`scripts/phase-graph.sh --mcp [N]` and `viewer/server/parse/plan.ts`), re-injected into every
  boot prompt and the QA brief, and held in step by `engine-parity.test.ts`.
- **A per-instance MCP registry** (`viewer/server/mcp/`), modelled on `accounts/`: `store.ts` holds
  no secret, `credentials.ts` is the only file that touches one (keychain, else 0600), `catalog.ts`
  suggests servers from a verified curated list plus the official registry, `config.ts` resolves a
  set into the `--mcp-config` document, and `index.ts` is the facade whose every answer is already
  redacted. Behind `--allow-mcp`; reading the registry, the statuses and the catalog is not gated.
- **A preflight that parks before it spends.** `system/init` from a one-turn `claude -p` reports
  each server's real status, so a run whose servers cannot connect stops at boarding with a message
  naming the server — and requeues itself when the server is signed in.
- **`--mcp-config` on the spawn**, always with `--strict-mcp-config`, so the resolved set is the
  only set an unattended session gets rather than whatever the machine happens to hold.
- **Rug-pull detection.** Every probe fingerprints the tools a server advertised; a change raises
  an alert instead of being absorbed silently. Tools marked `requiresUserInteraction` are flagged
  too — an unattended run can never approve one.
- **Per-phase MCP call counts**, so "was attaching that worth it" has an answer. A server at zero
  was paid for on every turn and never used.
- **F15** — a plan naming a server this machine has not registered warns at plan time on stderr,
  exit code untouched, in exactly F14's shape.
- **An MCP page, a Settings card and a guide section**, plus attachment in the launch dialog, the
  Autopilot controls and the phase matrix.

### Changed

- **A phase's weight includes its servers.** `scripts/mcp.env` (F5) holds the surcharge, read by
  `phase-graph.sh` and documented in `references/sizing.md`, so session batching stays honest about
  what an attached server costs on every turn.

## [1.8.0] - 2026-08-07

A plan that stated its verification was read as having none. The bullet reader treated any
0–3-space bullet as top level, so a §Verification written as nested 2-space sub-bullets — the
shape LLM authoring sessions naturally produce, five hub plans already carry it — parsed to an
empty string. The autopilot then parked every ready phase with "the plan states no verification"
(false), halted with a fixed tail advertising gate confirmation and Repair-with-AI to a run with
no gate and no blocked handoff, and nothing anywhere could heal it. This release fixes the read,
makes every earlier link of that chain visible, and closes the loop so the same defect now
repairs itself.

### Fixed

- **`labelledBullets` keeps nested sub-bullets** (`viewer/server/parse/markdown.ts`). Indentation
  is the nesting signal: while a bullet is open, only a column-0 bullet starts or closes a field;
  an indented bullet folds into the open bullet's body, and a nested bold label (`  - **Verify
  in:** api`) is ALSO emitted addressably — same-line remainder only — so `verifyIn` resolves
  from either level. Heals `verification`, `files`, `steps`, `gates` and the QA brief's
  Verification block for every plan written in the nested shape.
- **Park messages blame the right thing.** "The plan states no verification" is now reserved for
  plans that actually omit the bullet; a declared-but-unreadable one gets its own sentence
  pointing at the format reference, and the drive loop's halt tail names only doors that exist —
  gates when a gate blocks, Repair-with-AI when a handoff is blocked, Retry/Skip when something
  failed, a plan edit / repair for a verification park.

### Added

- **F14 (warning, never gates)**: `phase-graph.sh --lint` — and therefore `validate.sh` and the
  console's lint panel — names every open, not-done phase whose §Verification would extract
  nothing runnable, at plan time instead of boarding time. Closed plans are not scanned.
- **Start-time preflight**: `POST /api/run/<slug>/start` answers `{ run, preflight }` — the same
  extractor boarding uses, run over every open phase the moment the operator presses Start.
- **Boarding warnings are visible**: `PhaseRecord.preflight` carries the refused-fragment /
  cwd-sensitive / missing-lead warnings onto the run page (they previously lived only in the
  journal, which nothing renders); cleared on retry.
- **A verification-parked run heals itself.** The all-verification halt carries
  `kind: 'verification-preflight'` + an anchor phase; auto-recovery classifies it as
  `plan-repair` (kind-gated — lock parks stay a person's), the repair agent gets advice to author
  the §Verification from the phase's exit criteria (honestly — never `true`), the verdict is
  re-extraction rather than warning-tier lint, the write-back resets parked phases to **pending**
  (never `done` — they never ran), and the existing auto-continue resume boards them again.
  Bounded by the standing caps: 2 attempts per phase, 5 per run, identical failure twice refused.
- **`healthIssues` kind `verification-unrunnable`** (warning) — the issue that makes the repair
  resolvable, visible on the plan/stats surfaces, scoped away from done phases and closed plans.
- **Docs**: `references/plan-format.md` §6 shows BOTH accepted §Verification shapes and the
  machine contract; the console's plan wizard and SKILL.md Mode 1 name the runnable-Verification
  requirement beside dependencies, sizes and exit criteria.

## [1.7.0] - 2026-08-07

Gates get categories, and a door. A `manual` gate used to be a wall with no way through — the
autopilot parked the phase forever, and the only fix was hand-editing the plan — while gates a
session could perfectly well clear ("is staging deployed? is the smoke suite green?") were flagged
human anyway and stranded an operator on work that was never theirs. Every gate now says **who can
clear it**: `ai` gates make the check the booted session's *first task* — verify each condition, do
the work to make failing ones true, record the clearance, then implement — and `manual` gates carry
numbered operator steps that the phase page renders next to an **Approve** button. One approval
record clears a gate of any kind, and revoking it puts the wall back.

### Added

- **The `ai` gate type** (`- **Gate-check:** ai <check>`). The engine's boot prompt orders the
  session to verify the plan's Gates conditions, fix what fails, record the clearance and continue —
  and the autopilot boots ai-gated phases instead of parking them, because booting IS how that gate
  clears. `--gate-kind N` answers the category (`human` · `ai` · `auto` · `none`); the vocabulary
  lives in `scripts/gates.env`, one source for the bash engine and the console (the sizing.env
  pattern), pinned per phase by the engine-parity suite.
- **`scripts/gate-approve.sh <slug> <N> [--by WHO] [--note TEXT] [--revoke]`** — the clearance
  record. An approved row in `docs/handoffs/<slug>/gate-status.md` clears `--gate-status` for
  **every** gate kind (the operator's override, same philosophy as a QA waiver); revoking restores
  the gate. Deliberately a separate file from `test-status.md`, whose very existence flips QA gating.
- **The Gate card** on the console's phase page: category chip, the plan's own instructions rendered
  whole (numbered steps for human gates), the live verdict, a press-twice **Approve** with a note
  field, **Revoke**, and — when this plan's run is holding the phase at the gate — a *continue the
  run* checkbox so approving and resuming are one action. `POST /api/plans/:slug/gate/:n` behind
  `--allow-writes`, next to the existing GET.
- **Category-aware prompts everywhere**: the boot prompt's gate block now branches — ai gates get the
  verify→do→record→continue order, human gates get the operator steps plus where to approve, an
  approved gate says "proceed", and auto gates print their live verdict. `next-phase-prompt.sh` and
  the handoff's `## ▶ Start next phase(s)` markers carry the category too (`🔒 GATED·ai` /
  `·human` / `·auto`).

### Changed

- **The runner holds human/auto-gated phases as `gated`, not `parked`** — the reader's next move is
  different, and now the label says so. `gated` joins the settled set (no more re-checking a wall
  every loop pass), Retry re-checks the gate, and the parked-run banner quotes it by its real name.
- **`PHASE_EXEC_GATES=1` is finally true.** The engine's comment always claimed the console's runner
  opts into `cmd` gate execution; the runner never did, so every cmd gate reported "not executed"
  forever. The runner now sets it for its gate checks — page views still never execute plan-authored
  commands.
- **Multi-line gates survive whole.** `gate_conditions` was a `grep -A6 | head -1`: six lines of
  blindness and a mid-sentence truncation for any real instruction list. It is block-scoped now, so
  the boot prompt prints the same full steps the console renders.
- **`readGateStatus` keeps `kind` a clean token** — `clear (cmd ok): <cmd>` no longer leaks the
  parenthetical into `kind`; clear verdicts read `{kind: 'clear', detail: <reason>}`.
- An uncategorized gate (a `*(GATED)*` heading with no `Gate-check`) reads as **human** — the safe
  default — and the plan's health issues nudge, at `info`, to categorize it. Deliberately not a bash
  lint failure: legacy plans with prose-only gates must not start failing `validate.sh` mid-run.

### Fixed

- Previously-untested gate types (`phases`, `plan`, `cmd`, `deadline`/`by`) and the gate lint rules
  now have bats coverage, alongside the new approval/revoke/boot-prompt suites.

The run heals itself, and the console stops keeping secrets from its own surfaces. A recovery
session's success now *moves the run record* — phase done, halt cleared, run resumed — instead of
vanishing into a notification while the board stayed "halted"; halts an agent can clear launch that
session by themselves, bounded, so one press of autopilot carries a plan to the end or parks it on
something only a person can do, named. Agent sessions gain the lane verbs (Freeze / Continue / a
polite Stop). The shipped deny list joins strike-and-restore, behind the one confirm on the policy
page. And a stale browser shell stops being a mystery: waiting interface updates apply themselves
at the safe boundaries, and Settings says which build this tab actually is.

### Added

- **Recovery write-back.** When a Fix-with-AI session ends and the board reads fixed, the run
  record moves with it: the phase flips to `done`, the halt clears, the failure streak resets, and
  the run lands on `parked` with `Runner.recover`'s own wording. A not-fixed outcome annotates the
  attempt and leaves the halt standing. The write goes to the pooled runner's in-memory state when
  one holds the run (the object `runFor` actually serves), never under a live loop.
- **Auto-continue.** A fixed run resumes by itself — the same resume Retry and the limit clock make,
  sticky scope and skills included — under the new `autoContinueRecovery` automation pref (on by
  default). Manual recoveries count too: a fixed run is a run to carry on.
- **Auto-recovery.** A halt whose named kind an agent can clear (`verify-failed`, `plan-lint`,
  `no-handoff`, `phase-crashed`, an interrupted run) launches the recovery agent by itself: at most
  2 launches per phase, 5 per run, never the identical failure twice, never the human-shaped halts
  (auth, budget, models exhausted, a failure streak), spawned as the run's own account, bumped and
  persisted at launch so a console crash cannot forget an attempt, re-armed at boot. Per-run toggle
  in every launch dialog (needs `--allow-agent`), `autoRecoverByDefault` pref in Automation.
- **Halt kinds.** `run.halt` now carries a machine-readable `kind` written at the halt site; the
  classifier reads names, and only the unmistakable sentences of pre-kind records.
- **Per-session Freeze / Continue / Stop for agents.** Every pty session (recovery, QA,
  interactive, shell) gains the lane verbs: SIGSTOP/SIGCONT to the process group, and a polite stop
  (SIGCONT → SIGTERM → SIGKILL only after a 15 s grace) that KEEPS the record — a stopped verdict
  session still gets its outcome read against the board, and the `--resume` id survives. In the
  agent and terminal keybars, with frozen/stopping markers on the tabs;
  `POST /api/terminal/<id>/(freeze|thaw|stop)`.
- **Shipped deny rules strike and restore** like ask/allow — by name, scoped, journaled, reversible
  (↩ and Restore defaults) — a deliberate reversal of "no browser can unpick the wall", on its
  terms: the browser confirms a shipped-deny strike before writing it (the one confirm on the
  page), the per-run push carve-out never resurrects a struck wall, and profiles still move only
  the ask list. The strike reaches the CLI-side settings every child runs under — that is the
  point, and the docs say the risk plainly.
- **Desktop launcher rev 7.** The template gains managed `REMOTE`, `REMOTE_USERS`, `MAX_SESSIONS`
  and `DEFAULT_SKILLS` knobs, composed into every start path (supervised install and both
  foreground exec lines); Settings bakes this console's own values in. The Linux entry carries the
  same extras and names its instance. A rev-6 copy is told it is stale.
- **The start-command card composes the whole console**: remote hosts and users, a non-default
  session ceiling, default skills — plus a footnote naming the flags deliberately left out.
- **Interface updates apply themselves** at the two boundaries where nothing can be lost — page
  load and return-to-tab — guarded against loops (a one-shot marker falls back to the toast) and
  suppressed over live pty surfaces and focused inputs. Mid-session updates keep the toast.
- **Settings says which build this tab is.** A new Interface row compares the tab's baked commit
  (`__BUILD_REV__`, same computation as `dist/.build-rev`) against what the server serves.
- **`phase-console remove <sel>`** forgets a stopped console's registry row (state stays put);
  `list` hints it for stopped rows. Removal refuses a running instance.
- **Honest surfaces**: the Permissions card renders with no source directory open (the policy
  routes moved above the no-root wall — the global policy is an instance fact); run notes say
  "Parked — needs you." with the needs-human hint and the failure-streak counter; `--help` gains
  the `--open`, `--instance` and `--max-sessions` lines it always should have had.

### Changed

- **`POST /api/launcher` now requires `--allow-writes`** — writing a 0755 executable to the Desktop
  is a write, and a read-only console refuses it like every other one. The card's button says so.

### Fixed

- The `recovery-outcome` event finally has client consumers: the run/plan queries re-read
  themselves off it and a toast states the verdict — previously the run was fixed on disk while
  every open tab kept the halt banner until a manual reload.

## [1.5.0] - 2026-08-06

One console, many Claude accounts. Each instance now keeps its own account registry — the machine
login, profiles you sign into, pasted `claude setup-token` tokens — with live usage meters in the
chrome (the same numbers `/usage` shows: 5-hour, weekly, per-model, with reset countdowns). Every
launch surface picks which account a run spends, and a run that hits its usage window no longer
just sleeps on it: by policy it checkpoints the session and continues at once under the account
with the most headroom, carries its transcript along, and survives a console restart with the
resume clock intact.

The autopilot's controls grow down to the single session while its promise grows up to the whole
plan. Every session tab carries its own Freeze/Continue and Stop, scoped to that lane alone, and
the run page shows the **second queue** — a Waiting tab naming every dependency-waiting phase and
exactly what it waits on, so a plan's later phases never look abandoned while the early ones run.

And Settings stops describing work and starts doing it: the exact start command for *this* machine,
a Desktop launcher a button writes, and shipped permission defaults you can strike by name and put
back. The Guide's long scrolls become cards on a line.

### Added

- **Usage meters in the chrome.** Desktop rail, phone header and the More sheet all carry the
  5-hour and worst-weekly bars — read across **every** account, so a second login nearing its wall
  is visible before it stops anything — with a dialog listing every account × every window the
  usage endpoint reports. Bucket keys render by name, so a window that ships tomorrow appears
  tomorrow. Polling is deliberately gentle (single-flight, adaptive cadence, backoff on 429) and
  failure serves the last-known numbers with their age attached rather than a blank.
- **`--allow-accounts` — per-instance account registration.** Sign a second account in (the console
  mints a terminal on `claude auth login` under a managed `CLAUDE_CONFIG_DIR`, then reads back the
  email and plan) or paste a `claude setup-token` token and name it. Secrets live in the keychain
  or a 0600 file, never in the registry, never in an API response — and the console never writes
  the CLI's own credentials. Reading the meters needs no flag.
- **An account per run, and an on-limit policy.** The run form, phase launcher, recovery and QA
  dialogs and the agent launcher all offer the account (including `auto` — most 5-hour headroom)
  and, for runs, `switch` / `wait` / `pause`. `switch` checkpoints the live session at the wall and
  re-attempts immediately under the account that can pay, porting the transcript into that
  account's config dir so `--resume` finds the conversation; when nothing can be ported it starts
  from the boot prompt rather than resuming into nothing. The picker lists every login with the
  current one marked, and the start-time auth preflight probes **the run's own account** rather
  than the machine login — a run pinned to an expired profile is refused up front instead of
  burning a session per phase discovering it.
- **Switch account mid-run.** Its own verb on the run card, not a settings field: a live session is
  checkpointed (SIGCONT+SIGTERM, session id kept) and the phase re-attempted under the other login
  right away; a lane asleep on the old account's window is woken instead of waiting it out.
- **Account rename and hardened removal.** `PATCH /api/accounts/:id` renames the display name
  (ids are journal keys and never change), the machine login included; removal now also clears the
  profile's hashed keychain item on macOS and refuses while a live run pays as that account.
- **Expired-login alerts.** Every account's credential is watched with its meters; a login that
  goes from good to expired/signed-out (after the CLI's own refresh is tried) announces *Sign in
  again*, badges the account, and the run page's sign-in card names the right account with the
  right command.
- **Per-model walls, filed properly.** A "You've hit your Opus/Fable limit" records under its own
  bucket (`seven_day_opus`, …), so `auto` and mid-run switching skip that account only for runs of
  that model.
- **Restart-safe limit waits.** A run asleep on a usage window used to reconcile to `interrupted`
  after a console restart — self-resuming turned into waiting-for-a-person. It now reconciles to
  `paused` with its clock intact, and the service re-arms the resume at boot (unless the run's own
  policy was `pause`, which means what it says).
- **Two notification categories for usage, muted from where the noise is.** *Usage limits* carries
  every wall actually hit with its reset time and what the run did about it, the pre-flight warning
  when a run starts against a nearly-spent window (≥97% refuses, with the reset time in the
  message), and the sign-in alerts. **`usage-climbing`** — the 80% and 95% early warnings per
  account and window, with hysteresis, once per window — is its own category and off by default, so
  muting the climb never mutes the crash. The *Usage limits* mute is repeated in the meters dialog
  itself, saying what it silences and what stays on: nobody forms the intention "stop telling me
  about usage" while reading a list of notification categories; they form it looking at the meter
  that just buzzed them.
- **Per-session Freeze and Stop**, on the autopilot's session tabs, the Runs page's lanes, and the
  session console's toolbar. Freeze SIGSTOPs one lane and the run keeps driving (`frozen` now means
  *everything* is frozen); Stop ends one session (SIGCONT → SIGTERM → SIGKILL backstop), records
  its phase `interrupted` with the session id kept for Retry, and the loop carries straight on. A
  queued phase's Stop dequeues it before anything spawns. `POST /api/run/:slug/stop|freeze|thaw`
  now honour the `{phase}` body they always accepted.
- **The Waiting tab** — dependency-waiting and stuck phases beside the session tabs, each with its
  unmet dependencies (QA-held ones included), gate notes and ETA, and the run header states the
  promise outright: *runs to plan completion*, with the failure budget beside it once any of it is
  spent.
- **Run lifecycle from the fleet.** Live rows on the Runs page carry Freeze/Continue and Stop —
  a live run is no longer a row you can only link away from.
- **Start with every capability, on Settings.** The full start line for *this* instance — its skill
  root, source directory, port and all five switches — with a copy button and a note naming which
  capabilities the running console currently lacks. Every path renders as `$HOME/…`, so the line
  pastes on any account and a screenshot carries no username, and it is stated per OS: this
  machine's form first, the other Unix noted, Windows answered honestly as WSL.
- **A one-click Desktop launcher.** Create writes the artifact itself — macOS gets the shipped
  `.command` with root and port patched in `$HOME`-relative and all five switches on; Linux gets an
  XDG `.desktop` with absolute `Exec` paths (and GNOME's *Allow Launching* said rather than hidden);
  Windows gets the WSL story instead of a shortcut that breaks.
- **Permission defaults you can strike and put back.** Every shipped `ask`/`allow` default gets an
  ×, struck **by name** at the chosen scope — so an upgrade's new defaults still apply, which a
  copied-and-edited list would silently prevent — listed struck-through with ↩ to restore one, and
  a Restore defaults button per part. The shipped **deny** list stays the wall: not removable from
  a browser, ever, and the policy file's shape is what enforces it.
- **The Guide as cards on a line.** Nine long scrolls become grouped, collapsible cards cut from
  the markdown's own outline (shallowest heading present = group, one deeper = card, fence-aware),
  with `?card=` deep links, expand-all, and a route strip of stations for the sections that really
  are a sequence. Desktop opens every card but the bulky ones; a phone opens the first. The
  183-line *Running* section splits in two: **Running** is how you start the console, the new
  **Run** section is what a run then does.

### Changed

- **The scheduler's usage throttle is per account.** One limited login used to stall every queue;
  now only admissions spending the limited account wait, the queue names which account was told to
  come back when, and `throttledUntil` stays as the soonest expiry for older readers.
- **Recovery prompts know a limit stop from a crash.** An interrupted-resume brief now says the
  stop was quota — which account, when the window reopens — so the session continues the work
  instead of "fixing" anything on account of the stop. The skill's own Mode 2 gained the matching
  recovery step for hand-driven sessions (read `git status`/`git diff` first, re-claim, continue),
  and Mode 3's stop-reasons now include an exhausted usage window.
- **The desktop launcher template carries the `ACCOUNTS` knob** (`--allow-accounts`, on by default
  like the other four), threaded through every path a flag travels: the plist drift check, the
  `agent.sh` install argv, the carried-flags scanner, the running-console mismatch report and both
  foreground exec lines. `LAUNCHER_REV` is 6, so every installed copy is told it is stale rather
  than silently starting a console whose Accounts card says the flag is off.
- **The launcher card drops its paste-into-Claude section.** The Create button writes the launcher,
  so the manual procedure no longer sits beside it; the walkthrough still lives where readers
  without a running console find it — the guide and the README, from the same
  `shared/setup-prompts.js` string the contract test asserts.
- An old client against a new server keeps working: the `{phase}`-less stop/freeze/thaw verbs are
  unchanged. A **new** client's per-session verbs against a pre-update server degrade to the
  mismatch guard (409 when the phase is not the one running) — restart the console after updating,
  as the stale-server banner already says.

### Fixed

- **`./start` finds a usable node** — Homebrew, `/usr/local`, volta, then the newest nvm version —
  when the one on `PATH` is below the floor, instead of refusing. A machine whose default `node` is
  an old nvm alias was told "phase-console: no…" while a perfectly good v24 sat one directory over.
- A resumed run inherited its spent failure streak, so one more failed phase halted it instantly
  however long ago the failures were. Start/Continue now resets the streak (journalled as
  `run.failure-streak-reset`).
- Run-level **Freeze now** froze only the mirror lane of a multi-lane run while calling the whole
  run frozen; it now freezes every running session, and per-lane freezes persist on the checkpoint
  so crash recovery names each stopped pid.
- A phase skipped (or now stopped) while queued still spawned a session when its admission was
  granted; a settled record is abandoned on arrival.

## [1.4.0] - 2026-08-05

A claim on a phase now means something. Every phase table shows who holds a phase and for how much
longer, all four of them agree about what a phase *is*, and the console refuses to start a session
on work somebody else is already doing — instead of accepting the launch and discovering the
collision three subprocesses later.

### Added

- **A Lock column on every phase table.** The Autopilot table carried each phase's claim in its data
  and read it nowhere: a phase could be held by another session and the table would still offer to
  start it. It, the Departures board, the Phases list and the Overview graph now all show **held by
  … · 18m** or **stale claim**, with the owner in the chip rather than behind a hover — there is no
  hover on a phone.
- **Dependencies on every phase table.** What a phase waits on and what waits on it were on the wire
  for every row and rendered richly in one place. Both directions now appear everywhere, always —
  the Departures board used to show them only while a phase was *waiting*, so the plan's shape was
  invisible on every row that was moving.
- **An expandable sheet on every Autopilot row** carrying every remaining field: goal, gates and
  their live check, read-first, files, steps, exit criteria, verification, handoff-must-record,
  model, effort, weight, parallel-safe, downstream count, handoff status and outstanding work, the
  QA report, and the full claim (owner · host · claimed · lease · scope).
- **A claim ring on the route map**, and stations whose tooltip names what they wait on and who
  holds them.
- **`Release the claim`** — a confirmed, audited force-release for a claim whose lease is still
  running. Previously a live claim could only be cleared from a terminal, which was fine while a
  claim was decoration and a dead end once one started blocking runs. The dialog names the holder,
  the machine and the time left before it will do it.
- **A claim vocabulary** in the Guide's Reference, single-sourced with the chips' own tooltips.

### Changed

- **A live claim refuses a launch, in the server as well as the page.** `POST /api/run/<slug>/start`
  on a claimed phase used to answer **200**, mint a run, and only degrade to `parked` deep inside the
  runner — the console reported a run that never ran. Starting a named phase, retrying one,
  recovering one and reviewing one all now answer **409** with the holder, the host and the lease.
  A whole-plan run is deliberately *not* refused: it parks the claimed phase and gets on with the
  rest, because one claim should not stop a plan.
- **Buttons a claim blocks are disabled, not hidden** — they keep their place and say who holds the
  phase. A button that vanishes teaches nothing about why nothing can be started.
- **Repos renders as scope chips on the Departures board**, which was the one table of three still
  printing the raw graph cell.

### Fixed

- **A lapsed claim no longer parks a phase.** `phase-lock.sh status` prints `held by X` for an
  expired claim too and appends `(EXPIRED — free to take over)`; the runner read only the first half.
  A session that died without releasing therefore blocked its phase for the whole lease — and then
  kept blocking it, because nothing renews a dead claim. A lease running out is precisely the event
  that means *go*.
- **The per-phase claim payload no longer drops `host`, `claimedAt` and `scope`.** Two call sites
  narrowed the parsed lock by hand and had already drifted apart, so the same claim described itself
  differently depending on which list you found it in. One helper does it now.

## [1.3.0] - 2026-08-05

One install, one console per project. `cd` into a repository and `phase-console start` — it gets its
own port, its own state and its own supervisor, while the consoles for your other projects keep
running. A single-project machine gains nothing new and loses nothing: the first console keeps port
4123, the plain unit name and every path it already had.

### Added

- **Per-project consoles.** A console belongs to a repository root, and its identity is derived from
  that path (`sha256(realpath(root))[:8]-basename(root)`), so the same project is always the same
  console across restarts and reboots with nothing written down. `viewer/shared/instances.mjs` is
  the single definition of identity, the registry and ports — imported rather than re-derived, so
  the bash, Node and server readings cannot drift apart.
- **`phase-console list`** — every console with its name, root, port, status and unit, status from a
  live 2s probe rather than from what the registry hoped.
- **`phase-console open [<sel>]`** — open one in the browser; refuses when it is stopped and names
  the command that starts it. `PHASE_CONSOLE_NO_OPEN=1` makes it print the URL instead.
- **Instance selectors on every verb.** `start`, `stop`, `restart`, `status`, `logs` and `open` each
  take `[<instance>]`, `--instance <sel>` or `--root <dir>`; with none, they mean the console for
  the directory you are standing in. A selector matches an id, a name, or a unique folder name.
  `status` with no selector reports **all** consoles.
- **`.phase-console.json`** — commit `{"name": …, "port": …}` at a repository root to name that
  project's console for everyone who clones it, or to pin its port.
- **A registry** at `~/.config/phase-console/instances.json`: name, root, port, unit, pid per
  console. Ports are reserved by *registration* rather than by being bound, so a stopped console
  still owns its port and a restart lands where it was.

### Changed

- **Ports.** The first console on a machine keeps 4123. Every other project derives a stable port in
  **4124–4223** from its path; if something already holds it the server probes upward and records
  what it actually bound. Precedence: `--port` → `PHASE_CONSOLE_PORT` → `.phase-console.json` → the
  port it last actually bound → derived. Naming a port explicitly turns probing off, because naming
  one means wanting it.
- **Starting a console on a port that belongs to another project is refused by name**, naming the
  project that owns it, instead of failing with an address-in-use.
- **Per-console state.** Logs, notifications, push keys and subscriptions, approvals and settings
  live under `instances/<id>/`. The default instance keeps the top-level paths byte-for-byte, so
  nothing moves on upgrade; run journals were keyed by repository already and move for nobody.
- **Per-console supervisors.** Generated units are `com.phase-console.<id>` /
  `phase-console-<id>.service`. The default instance keeps the bare pre-1.3.0 names, so upgrading
  never renames the agent you already have. `agent.sh install` gained `--instance`, and its `--port`
  now defaults to the *instance's* port rather than to 4123; `uninstall` clears only the registry's
  `unit` field, because the instance still exists — it just has no supervisor.
- **The plans page reports what it is hiding.** With closed plans and documents hidden by sticky
  preferences, a large library could render a single row and explain itself in a grey line. The
  toggles now carry what they would bring back (`Show closed +71`) in the accessible name as well as
  the pixels, a dismissible banner appears when the shape filters hide most of the source, and the
  subtitle says "1 of 87 rows" — a true sentence about the list rather than a false one about the
  source. The defaults are unchanged.
- **Closed plans are marked where they were not.** The plan header carries a `CLOSED · <status>`
  badge rather than a chip, and the plans *table* gained a marker it never had — every other signal
  it shows is one closure suppresses, so a closed plan rendered as a live plan with nothing to do.
- CI isolates `runner-parallel.test.ts` with one retry. Two of its tests measure scheduling against
  real sleeps, and one failed the v1.2.0 release on macOS while the CI workflow passed the same job
  on the same commit concurrently — both workflows fire on a tagged push and race for runners.

### Fixed

- **Two consoles booting together could lose one another's registry entries.** `withRegistry` gave
  up on a contended lock immediately and wrote anyway; the write is atomic but read-modify-write is
  not, and the lost field that matters is `pid` — the one thing `stop` needs for an unsupervised
  console. It now waits up to 2s for the lock before falling back.
- **The default-instance election now happens inside the registry lock.** A caller that read "is
  there a default yet" and then registered could race another doing the same, and the loser would
  silently inherit the legacy port *and the legacy state directory* — another console's log and push
  subscriptions.
- **A `name` in a committed `.phase-console.json` could inject a line into what `agent.sh` reads.**
  The file arrives with a clone and its name reaches `key=value` lines bash parses a unit path out
  of. Control characters are now stripped at the source, replaced with spaces so nothing is silently
  joined.
- `config.ts` imports `STATE_DIR`, `instanceStateDir`, `configDir` and the legacy unit name from the
  shared module instead of keeping second copies. `configDir` falls through `env` → `process.env` →
  `homedir()`, so a caller passing a *partial* env can no longer escape a sandbox and read the real
  registry.

## [1.2.0] - 2026-08-05

A plan can be closed — an off switch for work that will never be finished.

### Added

- **`scripts/close-plan.sh`** — close a plan with a dated reason
  (`close-plan.sh <slug> --reason "…"`, optionally `--status superseded|complete`), or `--reopen` to
  undo. Writes only the plan's frontmatter (`status`, `closed`, `closed_reason`) and releases that
  plan's own phase locks. Never runs git.
- **`phase-graph.sh --plan-status` and `--closed`** — the closure predicate, defined once so every
  other script asks rather than re-parsing frontmatter.
- `status: superseded` joins the documented vocabulary alongside `active`, `complete`, `abandoned`.

### Changed

- **A terminal status (`complete`, `abandoned`, `superseded`) now means the plan is closed**, and a
  closed plan stops reporting: no ready phases, no QA-failure or stuck-handoff alarm, no batching,
  no boot prompts, no "mark the plan complete" nudge. Its board still renders in full — closing
  quiets a plan, it never hides one — and structural problems are still named, demoted to notes.
  Previously `status:` was documented but honoured nowhere, so a finished or abandoned plan kept
  raising errors with no way to stop it.
- `validate.sh` skips a closed plan instead of flunking it forever; `next-phase-prompt.sh` prints a
  closure notice instead of boot prompts; `new-handoff.sh` refuses to scaffold into a closed plan
  (`--force` overrides).
- **`phase-lock.sh conflicts` ignores locks belonging to a closed plan.** The scan crosses every
  plan, so an abandoned plan's leftover lock used to block sessions on unrelated plans until its
  lease happened to lapse.
- The all-phases-done banner now points at `close-plan.sh` rather than asking for a hand edit.
- **The console honours closure too.** A closed plan contributes no health issues (progress problems
  are dropped; structural damage stays, demoted to `info`), no ready phases, no remaining weight or
  sessions, and never appears as stalled — and `POST /api/write` gains `close-plan` / `reopen-plan`,
  so a plan can be closed from the console with the same validated argv an operator would type.
  Search still finds closed plans, by design.
- **A closed plan no longer sends notifications about its own progress** — phases landing, work
  becoming ready, a plan finishing, files changing. Notifications about a live *process* —
  permission needed, a phase awaiting a person, a halted or parked run, a session ending, console
  health — still fire, because a stale `status:` line must not be able to strand a running session
  in silence.
- Repairing a closed plan is refused with a 409 that says to reopen it first, rather than reporting
  that there is nothing to repair.
- **A closed plan now reads as closed everywhere in the console, and can be closed or reopened from
  it.** The plan page leads with a banner saying which terminal word applies, when, and why; the
  status chip carries a padlock; and the plan's own action menu gains **Close plan** (a status and a
  required one-line reason, previewed as the exact `close-plan.sh` invocation) and **Reopen** (a
  confirm, because it silently puts the plan back on every board). Closed plans no longer appear on
  the departures board, in the "Ready now" nav badge or tile, in the dashboard's "start this next"
  recommendation, among the in-flight plan strips, or as ready chips and boot-prompt cards on the
  plan page; their stuck / QA / stale-lock / idle warnings are silenced, their structural damage
  stays visible but demoted, and a lapsed lock on one now reads as debris rather than a chore, since
  `phase-lock.sh` already ignores it. Search still lists them, now with a `closed` badge.
- **The plan list hides closed plans by default** — one toggle away, and a deliberate change of
  behaviour: the toggle it replaces ("Hide finished") defaulted to *showing* every finished plan, so
  a library of sixty-odd complete plans opened on all of them. A closed row that is on screen says
  what happened to it ("abandoned — 3 of 4 phases never ran") instead of offering phases to start.

  ⚠️ A plan's **per-plan** `ready` array stays populated when it is closed, on purpose — the engine
  reports what never got done so the plan's own board can say so, and engine-parity depends on it.
  Only the portfolio aggregates are gated server-side, so anything that turns `ready` into a call to
  action must gate it itself. `viewer/client/src/lib/closure.ts` is the one place the client decides.

- **Closure is documented as a plan's lifecycle, not a flag.** [The artifacts](docs/artifacts.md)
  gains the whole story — why "does anyone still care?" is the one piece of plan state that is stored
  rather than computed, and a table of exactly what closing stops and what it keeps. The command
  reference, the console's write verbs and the setup prompts list the new verb; the in-app Guide's
  "Status words" grows a **fourth** vocabulary (plan status) beside run, phase and board; and the
  Persian mirrors move with the English.
- **`docs/qa-gating.md` answers the question a permanent `fail` raises.** A recorded failure still
  outlives the QA switch, and closing the plan is now the documented other exit — it retires the
  report without a re-QA, because a closed plan claims nothing about progress. Re-QA clears a
  failure; closure stops you caring about one. Neither pretends the other happened.

### Fixed

- **The test suite no longer runs against the operator's own console state.** Spawned consoles
  inherited `XDG_STATE_HOME`, so they loaded the real `push/subscriptions.json` and delivered real
  push notifications to real devices — the shutdown test announced "Phase Console is shutting down ·
  asked for by a test" to a subscribed browser on every run — and the suite left thousands of
  fixture run journals in the real state directory. Every test now redirects its state and config
  directories, spawned consoles get a sandbox root instead of whatever library the config
  remembered, and `test/state-isolation.test.ts` fails if a new test file forgets either.

## [1.1.0] - 2026-08-05

Linux — and Windows through WSL2 — become first-class: same features, same buttons, honest
fallbacks where a platform has no equivalent.

### Added

- **systemd support.** `--install-agent` on Linux writes a `systemd --user` service
  (`Restart=always`, the same 150s stop grace, logs in the same files) instead of assuming
  `launchctl`; `--agent-status`, `--agent-restart`, `--agent-log`, `--uninstall-agent` and
  `--agent-update` all speak systemctl there. On WSL without systemd, install explains the one-time
  `[boot] systemd=true` enablement instead of failing cryptically.
- The server reads its own unit file (the unit stamps its name as `PHASE_CONSOLE_UNIT`) the way it
  reads a launchd plist: the Restart button is offered on read evidence (`Restart=` covering a
  clean exit), and **Shut down** ends a systemd-supervised console with `systemctl --user stop` —
  stopped means stopped.
- WSL-aware browser opening: `wslview` → `xdg-open` → `explorer.exe`, and a printed URL when no
  opener exists. "Open in editor" prefers the Windows side on WSL too.
- **Lifecycle words on the bin**: `phase-console start | stop | restart | status | logs [-f]`
  (and `--agent-start` / `--agent-stop` on `./start`). `stop` stops the supervised console without
  uninstalling it; `start` brings it back — or runs in the foreground when no agent is installed.
- **`phase-console install-skill`**: copies the skill's files from a package install into
  `~/.claude/skills/phased-execution` (or `$CLAUDE_CONFIG_DIR/skills`), so npm and Homebrew
  installs can register the *skill* with Claude Code too — no plugin or clone required. Stamped,
  so it refreshes or removes only its own copies and refuses to touch a git clone;
  `uninstall-skill` undoes it.
- CI proves it: the console suite and the bash-engine suite now each run on ubuntu as release
  gates beside the macOS runs.
- Releases open the Homebrew bump PR automatically (`TAP_GITHUB_TOKEN` armed).

### Changed

- README rebuilt around the published packages: an install table (npm / Homebrew / npx / plugin /
  clone), CI + platform badges, and a quick start. `docs/install.md` gains **Linux, and Windows
  through WSL2** — systemd, lingering, localhost forwarding, and the node-pty build-tools note
  (no Linux prebuilds ship; it compiles at install, and the console degrades honestly without it).
- `.secrets/` is now entirely gitignored — the token how-to lives in `docs/releasing.md` instead
  of a tracked file inside the drop-point.

### Fixed

- Docs no longer describe the background agent as launchd-only, and name the npm package
  unambiguously: it is `phase-console`, **unscoped** — `@zsarir/phase-console` is the
  auth-required GitHub Packages mirror, which the default registry answers 404 for.

## [1.0.1] - 2026-08-05

The same console as 1.0.0, released through the pipeline: this is the first version published by
`release.yml` from a `vX.Y.Z` tag — with npm **provenance**, the GitHub Packages mirror
(`@zsarir/phase-console`), and a GitHub Release carrying the tarball. 1.0.0 was the one-time manual
bootstrap publish that npm's trusted publishing requires before a publisher can be attached.

## [1.0.0] - 2026-08-05

First release — the console becomes installable as a package (published manually, once, to
bootstrap trusted publishing).

### Added

- **npm channel**: `npm install -g phase-console` (or one-off `npx phase-console`) — the whole
  skill tree with the client **prebuilt**, so the per-machine `npm ci && npm run build` step does
  not exist on this route.
- **Homebrew channel**: `brew install zsarir/homebrew-tap/phase-console`.
- `bin/phase-console.mjs` — symlink-safe Node entrypoint for packaged installs: resolves the
  package root through npm's global-bin symlink chain and Homebrew's `opt` path, maps a bare first
  argument to `--root`, hands the `--*-agent` verbs to `deploy/agent.sh`, and forwards exit codes
  and signals faithfully.
- Pack-time type strip: the tarball carries pre-stripped `server/*.js` beside the `.ts` sources,
  because Node refuses to run TypeScript from under `node_modules` — exactly where npm installs
  live. Entrypoints pick the `.js` only there; everywhere else the `.ts` stays the truth.
- CI from zero: test + scrub + tarball-content gates on every push and PR; a tag-triggered release
  workflow that packs, asserts and scrubs the artifact, publishes to npm with **OIDC provenance**
  (no tokens anywhere), creates the GitHub release, and can open a version-bump PR on the tap.

### Changed

- Honest Node floor everywhere: **>=22.18 or >=23.6** (native type stripping is unflagged only from
  those lines; 22.6 was never enough without a flag).
- `node-pty` and `ws` are `optionalDependencies` — the console's designed degradation carries the
  board, writes and autopilot even when the native module is absent. The client's build libraries
  moved to `devDependencies`; they are baked into `client/dist`.
- The desktop launcher and the setup prompts now also find npm (`npm root -g`) and Homebrew
  (`brew --prefix phase-console`) installs, and honor `PHASE_CONSOLE_HOME` as an override.

### Fixed

- `check-stamp` no longer compares a packaged install's build against whatever git repository
  happens to contain the install directory (Homebrew's Cellar sits inside Homebrew's own repo,
  which made every start cry STALE).
- `--install-agent` from a packaged install uses the shipped client build instead of dying on a
  build it has no sources or lockfile for.
