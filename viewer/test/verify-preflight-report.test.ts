/**
 * GET /api/plans/:slug/verify-preflight — the boarding preflight's findings,
 * structured and readable BEFORE any money is spent. The journal-only string
 * twin of this data predicted the dominant halt class 44 times and was
 * rendered by nothing.
 *
 * `missing-lead` is deliberately not asserted here: it consults the real
 * machine PATH (the point of the report), and this suite must pass on
 * machines that do have every tool. Its logic is pinned machine-independently
 * in verify-extract.test.ts via the injected probe.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');

const PLAN = `---
slug: pf
created: 2026-08-06
status: active
phases: 4
---

# pf

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | clean   | — | — | app | done |
| 2 | prose   | 1 | — | app | done |
| 3 | rooted  | 2 | — | app | done |
| 4 | human   | 3 | — | app | done |

## Phases

### Phase 1 — clean
- **Size:** S
- **Verification:**
  - **Verify in:** app
  - \`git status --porcelain\`

### Phase 2 — prose
- **Size:** S
- **Verification:** confirm the dashboard renders and feels right

### Phase 3 — rooted
- **Size:** S
- **Verification:**
  - \`pnpm test\`

### Phase 4 — human
- **Size:** S
- **Verification:**
  - \`git log --oneline -1\`
  - \`./scripts/deploy.sh --check\`
`;

test('the report names each phase by what boarding will find', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-preflight-report-'));
  try {
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'pf.md'), PLAN, 'utf8');
    const svc = new Service({
      port: 0, host: '127.0.0.1', open: false, allowWrites: false, allowRun: false,
      scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
    } as never);
    svc.push.announce = (() => {}) as typeof svc.push.announce;
    assert.equal(svc.open(root).ok, true);

    const report = await svc.verifyPreflightReport('pf');
    assert.ok(report);
    const byPhase = new Map(report.phases.map((row) => [row.phase, row.warnings]));

    // Phase 1: a runnable command and a declared Verify in — nothing to say.
    assert.equal(byPhase.get(1), undefined);
    // Phase 2: prose only — it will park at boarding.
    assert.equal(byPhase.get(2)?.[0]?.kind, 'nothing-runnable');
    // Phase 3: pnpm with no Verify in — cwd-unpinned.
    assert.ok(byPhase.get(3)?.some((warning) => warning.kind === 'cwd-unpinned'));
    // Phase 4: a mutating script beside a runnable command — a human check.
    assert.ok(byPhase.get(4)?.some((warning) =>
      warning.kind === 'human-check' && /deploy\.sh/.test(warning.command ?? '')));
    assert.ok(report.computedAt);

    // An unknown plan answers null (the route 404s from that).
    assert.equal(await svc.verifyPreflightReport('nope'), null);
    svc.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
