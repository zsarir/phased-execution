/**
 * What a claude session can be STARTED under, and what to call that afterwards.
 *
 * Two surfaces offer this list — the launcher's form and the plan wizard's —
 * and a third reads it back (the tab chip), so it lives in its own module
 * rather than in whichever view happened to need it first. The server
 * re-validates every value against the runner's `PERMISSION_MODES`
 * (`server/agent.ts`), so this file is vocabulary, never the wall.
 *
 * `bypassPermissions` is deliberately absent from `MODES`: it is not offered
 * here and it is refused there. It still appears in `MODE_NAME`, because a QA
 * session started on the bypass *profile* resolves to it, and a chip that
 * cannot name the one mode worth noticing would be worse than no chip.
 *
 * ⚠️ Data only — no imports. The wizard mounts in the plans chunk, so anything
 * this module pulled in would be pulled in there too.
 */

/**
 * The select's options. `''` is the CLI's own default (ask first), which the
 * runner's vocabulary spells as an omission rather than a value.
 *
 * Checked against the CLI reference on 2026-08-04: `--permission-mode` accepts
 * `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`,
 * and `manual` as an alias for `default`.
 */
export const MODES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Default — ask before acting' },
  { value: 'acceptEdits', label: 'Accept edits — file changes auto-approved' },
  { value: 'plan', label: 'Plan mode — read-only until a plan is approved' },
  { value: 'auto', label: 'Auto — the CLI decides what needs asking' },
  { value: 'dontAsk', label: 'Don’t ask — refuse rather than prompt' },
];

/**
 * The mode a plan-authoring session opens in.
 *
 * The server applies the same default (`buildAgentLaunch`, `intent: 'plan'`)
 * and is the one that decides — this constant only makes the wizard's select
 * agree with it on the first render, so the operator is never shown one mode
 * and given another.
 */
export const PLAN_MODE = 'plan';

/** Short names for the chip — the mode, not the sentence explaining it. */
const MODE_NAME: Record<string, string> = {
  '': 'default',
  manual: 'default',
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
  dontAsk: 'don’t ask',
  bypassPermissions: 'bypass',
};

/**
 * What to call the mode a session was launched under.
 *
 * An unknown value is returned as it stands rather than swallowed: a mode this
 * console has not heard of is exactly the thing worth showing verbatim.
 */
export function modeName(mode: string | undefined): string {
  if (!mode) return MODE_NAME[''];
  return MODE_NAME[mode] ?? mode;
}

/**
 * The honest title for that chip.
 *
 * ⇧Tab cycles the mode inside the session and tells nobody out here, so the
 * label is a record of how the process was STARTED. Saying that in the tooltip
 * is cheaper than a wrong label somebody trusts.
 */
export const MODE_TITLE =
  'The mode this session was launched in — cycling modes inside the session does not update this label.';
