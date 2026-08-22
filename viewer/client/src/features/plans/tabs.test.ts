/**
 * The plan page's tab vocabulary, as a contract.
 *
 * Three properties, and each one is a bug this codebase has actually shipped:
 *
 * 1. **Every id in `PLAN_TABS` has a label and a panel.** `autopilot` was once
 *    registered as `run` in the router and spelled `autopilot` in the server's
 *    notification links, so every approval push opened a blank page for the
 *    life of that feature. A test that walks the shared array is the only thing
 *    that catches an id existing in the URL vocabulary and nowhere else.
 * 2. **`run` survives.** The server routes every in-flight-run notification to
 *    it (`server/push/catalogue.ts`), and the Node suite asserts the other half.
 * 3. **A retired id still resolves.** `analysis`, `overview` and `raw` are in
 *    bookmarks and in handoff prose; the redirect is what moves the address,
 *    and this is what the strip shows for the render before it lands.
 *
 * The panel side is asserted against `detail.tsx`'s own switch rather than a
 * second list of ids — a list here would agree with itself and with nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_PLAN_TABS, PLAN_TABS } from '@shared/route-meta.js';
import {
  DETAIL_TABS,
  PLAN_TAB_LABELS,
  TAB_IDS,
  isLegacyTab,
  legacyTabTarget,
  resolveTab,
  tabLabel,
} from './tabs';

/** `detail.tsx`'s `TabBody` — the panel side of the contract, read as source. */
const detailSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'detail.tsx'), 'utf8');

describe('the plan tab vocabulary', () => {
  it('is exactly the shared list, in the shared order', () => {
    expect(TAB_IDS).toEqual([...PLAN_TABS]);
  });

  it('gives every id a real label — never the id falling through', () => {
    for (const id of PLAN_TABS) {
      expect(PLAN_TAB_LABELS[id], `no label for '${id}'`).toBeTruthy();
      expect(tabLabel(id)).not.toBe(id === 'run' ? '' : id);
    }
  });

  it('gives every id a real panel in TabBody', () => {
    for (const id of PLAN_TABS) {
      // `route` is the switch's `default:` — the fallback is deliberate, so
      // that an id the vocabulary gains before its panel lands on the map
      // rather than on nothing.
      if (id === 'route') continue;
      expect(detailSource, `TabBody has no case for '${id}'`).toContain(`case '${id}':`);
    }
  });

  it('keeps `run` — every in-flight notification is routed to it', () => {
    expect(PLAN_TABS).toContain('run');
  });

  it('has no id that is both live and retired', () => {
    for (const id of PLAN_TABS) expect(isLegacyTab(id), `'${id}' is both`).toBe(false);
  });
});

describe('the retired tabs', () => {
  it('names all three, and only tabs that really left', () => {
    expect(Object.keys(LEGACY_PLAN_TABS).sort()).toEqual(['analysis', 'overview', 'raw']);
  });

  it('sends the two file readings to Source and the numbers off the page', () => {
    expect(legacyTabTarget('overview')).toBe('source');
    expect(legacyTabTarget('raw')).toBe('source');
    // `analysis` names a HEAD, not a tab of this page — `planTabRedirect` in
    // `app/routes.ts` turns that into `#/insights?plan=…`.
    expect(legacyTabTarget('analysis')).toBeUndefined();
  });

  it('resolves a retired id to what it became, not to the fallback', () => {
    expect(resolveTab('overview')).toBe('source');
    expect(resolveTab('raw')).toBe('source');
  });

  it('keeps `raw` distinguishable from `overview` — see the ?view= note', () => {
    const raw = LEGACY_PLAN_TABS.raw as { tab?: string; view?: string };
    const overview = LEGACY_PLAN_TABS.overview as { tab?: string; view?: string };
    expect(raw.view).toBe('raw');
    expect(overview.view).toBeUndefined();
  });
});

describe('resolveTab', () => {
  it('opens on Route with no segment, and for a word nobody registered', () => {
    expect(resolveTab(undefined)).toBe('route');
    expect(resolveTab('')).toBe('route');
    expect(resolveTab('not-a-tab')).toBe('route');
  });

  it('shows the list a detail page was reached from', () => {
    expect(resolveTab('phase')).toBe('phases');
    expect(resolveTab('handoff')).toBe('handoffs');
    // And those two lists are themselves real tabs.
    for (const target of Object.values(DETAIL_TABS)) expect(PLAN_TABS).toContain(target);
  });

  it('is identity on every live id', () => {
    for (const id of PLAN_TABS) expect(resolveTab(id)).toBe(id);
  });
});
