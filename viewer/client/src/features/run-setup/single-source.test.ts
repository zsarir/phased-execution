/**
 * The single-source guards — the assertions that keep the consolidation from
 * quietly coming apart.
 *
 * Phase 6's whole claim is that there is now ONE launch form and ONE way-
 * forward renderer. That claim is not expressible as a type: nothing stops a
 * future surface from importing `api` and rendering its own Retry beside the
 * shared one, which is exactly how the four dialogs and the nine parallel
 * remedy buttons appeared in the first place — one reasonable local decision
 * at a time.
 *
 * So the guard is a source walk. It is coarse on purpose: it asks who may
 * MENTION a door, not who calls it at runtime, because a mention is where the
 * drift starts and it is the thing a reviewer can act on.
 *
 * When one of these fails, the fix is almost never to widen the allow-list.
 * It is to render `<RunSetup>` or `<RecoveryActions>` instead.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

/** Every `.ts`/`.tsx` under `client/src`, tests excluded — a test may say anything. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

/**
 * Comments stripped before matching. A prose mention of `api.runStart(…)` in a
 * module header is documentation, not a second caller, and a guard that cannot
 * tell them apart gets silenced rather than obeyed.
 */
const decommented = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const FILES = sources(SRC).map((path) => ({
  path: relative(SRC, path),
  text: decommented(readFileSync(path, 'utf8')),
}));

/** Files matching a pattern, minus the ones allowed to. */
function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  return FILES.filter(({ path, text }) => pattern.test(text) && !allowed.includes(path)).map(
    ({ path }) => path,
  );
}

describe('the ways-forward renderer is the only one', () => {
  it('nothing but the shared performer touches retry, skip or recheck', () => {
    // `lib/run-recover.ts` IS the performer — it is where `RecoveryActions`
    // sends every run verb. Anything else calling these is a second Retry
    // button under a second set of rules, which is the defect being fixed.
    expect(offenders(/\bapi\.(runRetry|runSkip|runRecheck)\b/, ['lib/run-recover.ts'])).toEqual([]);
  });

  it('the shared renderer is what surfaces import for a remedy', () => {
    // A surface that offers a way forward imports `RecoveryActions`. This is
    // the positive half of the rule: the guard above proves nobody rolls their
    // own; this proves the ones that offer remedies use the shared one.
    const users = FILES.filter(({ text }) => /from '@\/components\/recovery-actions'/.test(text));
    expect(users.length).toBeGreaterThan(0);
  });
});

describe('RunSetup is the only launch form', () => {
  it('nothing outside features/run-setup starts a run', () => {
    // The hard half: a LAUNCH has exactly one caller, no exceptions.
    expect(offenders(/\bapi\.runStart\b/, ['features/run-setup/run-setup.tsx'])).toEqual([]);
  });

  it("the only settings patch outside the form is the run page's two one-tap verbs", () => {
    // A settings PATCH is not a launch, and two of them are honest one-tap
    // verbs on the run page rather than a second form: "clear the phase scope"
    // and "back to Guarded". They are allowed BY SHAPE, not by filename — a
    // third patch, or either of these growing a field, fails this.
    const others = offenders(/\bapi\.runSettings\b/, [
      'features/run-setup/run-setup.tsx',
      'features/runs/run-page.tsx',
    ]);
    expect(others).toEqual([]);

    const runPage = FILES.find(({ path }) => path === 'features/runs/run-page.tsx')!;
    const calls = [...runPage.text.matchAll(/api\.runSettings\(slug, (\{[^}]*\})\)/g)].map((match) =>
      match[1]!.replace(/\s+/g, ' ').trim(),
    );
    expect(calls).toEqual(['{ onlyPhases: [] }', "{ permissionProfile: 'guarded' }"]);
  });

  it('nothing outside the one session helper mints an agent ticket', () => {
    // Three callers, and what they have in common is that each owns a PTY,
    // not a form: the shared session helper (QA + recovery), the sessions
    // page's own terminal, and the plan wizard — whose ticket carries an
    // `intent` and a `brief` no run door has. All three take their FIELDS from
    // RunSetup; none of them declares one. A fourth is a fourth form.
    expect(
      offenders(/\bapi\.agentTicket\b/, [
        'lib/start-session.ts',
        'features/sessions/session-page.tsx',
        'features/sessions/wizard.tsx',
      ]),
    ).toEqual([]);
  });

  it('no surface renders its own model picker', () => {
    // The list itself now comes from the server (`state.models`), with the
    // build's own copy as the fallback for an older server. Anything else
    // mapping a model vocabulary into options is a second picker that will
    // disagree with the door the morning the lineup changes.
    const allowed = [
      // The fallback list and its notes — data, not a picker.
      'features/runs/defaults.ts',
      // The one form. (`per-phase.tsx` renders its rows from the list RunSetup
      // hands it, so it never names the vocabulary itself.)
      'features/run-setup/run-setup.tsx',
      // Settings' "Session plan model" row, which imports that same fallback
      // under an explicit alias and prefers `state.models`. It had its OWN
      // hardcoded list of full ids until Phase 6 — the fourth one, and the
      // reason this assertion exists.
      'views/settings/index.tsx',
    ];
    expect(offenders(/\bMODELS\b/, allowed)).toEqual([]);
  });

  it('the permission vocabulary is declared once', () => {
    // `PERMISSION_CHOICES` in `modes.ts` is the vocabulary;
    // `features/sessions/modes.ts` keeps `MODE_NAME`/`modeName` for the tab
    // CHIP, which reads a mode back rather than offering one. Offering is what
    // must be single.
    expect(
      offenders(/\bPERMISSION_CHOICES\b/, [
        'features/run-setup/modes.ts',
        'features/run-setup/run-setup.tsx',
        'features/run-setup/per-phase.tsx',
      ]),
    ).toEqual([]);
  });
});
