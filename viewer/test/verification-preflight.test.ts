/**
 * Service.verificationPreflight — the boarding preflight's answer at Start
 * time, for every open phase at once.
 *
 * The runner's own preflight parks one phase at a time, mid-run; a defect
 * readable at creation used to surface hours later as a halt. This method is
 * the same extractor run over the whole plan when the operator presses Start,
 * and the start route ships its lines in the response. Three shapes matter:
 * nested sub-bullet verification (runnable — the parser keeps it now), a
 * declared bullet with nothing runnable in it, and no bullet at all — and a
 * done phase is history, not a warning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-verifypre-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');

const PLAN = `---
slug: preview
created: 2026-08-07
status: active
phases: 3
---

# preview

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | nested | — | — | app | green |
| 2 | prose | 1 | — | app | green |
| 3 | bare | 2 | — | app | shipped |

## Phases

### Phase 1 — nested
- **Size:** S
- **Verification:**
  - **Verify in:** app
  - \`npm test\`

### Phase 2 — prose
- **Size:** S
- **Verification:** run the suite by hand and eyeball the output.

### Phase 3 — bare
- **Size:** S
`;

test('start-time preflight names each phase that would park, by its actual defect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-verifypre-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'preview'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'preview.md'), PLAN, 'utf8');

  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  try {
    assert.equal(svc.open(root).ok, true);

    const advisories = await svc.verificationPreflight('preview');
    assert.equal(advisories.length, 2, advisories.join(' | '));
    // Phase 1's nested sub-bullets are runnable — the shape that used to read
    // as "no verification" must produce no advisory at all.
    assert.doesNotMatch(advisories.join('\n'), /phase 1/);
    assert.match(advisories[0], /phase 2's §Verification yields nothing the runner can execute/);
    assert.match(advisories[1], /phase 3 has no §Verification/);

    // Scoping to a phase asks about that phase only.
    assert.deepEqual(await svc.verificationPreflight('preview', [1]), []);

    // A done phase is history, not a warning.
    writeFileSync(join(root, 'docs', 'handoffs', 'preview', 'phase-03-bare.md'), `---
plan: docs/plans/preview.md
phase: 3
title: bare
status: complete
---
# Phase 3 — bare
`, 'utf8');
    // The watcher would notice on its own clock; the test forces the re-read
    // so the board's revision-keyed cache turns over deterministically.
    (svc as never as { reread: (slug: string) => void }).reread('preview');
    const after = await svc.verificationPreflight('preview', [3]);
    assert.deepEqual(after, [], 'phase 3 is done — nothing to warn about');
  } finally {
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});
