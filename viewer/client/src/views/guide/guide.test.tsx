/**
 * The guide.
 *
 * The property worth a test is **totality in both directions**. `GUIDE_SECTIONS`
 * lives in `shared/route-meta.js` because it is the frozen URL vocabulary; the
 * content lives in `client/src/content/guide/*.md`. A section added to one and
 * forgotten in the other is either a tab that renders an empty page or a page
 * nothing can reach — neither of which is visible in a screenshot of the six
 * that do work.
 *
 * The deep-link case is the second: `#/guide/mobile` has to land on Mobile
 * setup, not on the first tab, because that URL is what the phone-setup
 * instructions tell people to open.
 */

import { homedir, hostname, userInfo } from 'node:os';
import { render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUIDE_SECTIONS } from '@shared/route-meta.js';
import { queryClientConfig } from '@/lib/queries';
import { SECTIONS, resolveSection, sectionIds } from './sections';
import { splitGuide } from './split';
import GuideView from './index';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, state: vi.fn(async () => ({ autopilot: true, allowRun: true })) },
  };
});

/**
 * Viewport width, per test.
 *
 * `lib/media.ts` memoises each `MediaQueryList` in a module-level cache, so
 * swapping `window.matchMedia` after import changes nothing — the first query
 * of a run wins for the whole file. Mocking the hook is the honest way to ask
 * "what does this render on a phone", and it is the pattern the rest of the
 * suite already uses for `@/router` and `@/lib/api`.
 */
let phone = false;
vi.mock('@/lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media')>();
  return { ...actual, usePhone: () => phone };
});

afterEach(() => {
  phone = false;
});

function renderGuide(segments: string[], query: Record<string, string> = {}) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <GuideView route={{ segments, query, path: segments.join('/') }} />
    </QueryClientProvider>,
  );
}

const outlineOf = (id: string) => splitGuide(SECTIONS.find((s) => s.id === id)!.body);

describe('the guide section registry', () => {
  it('covers every frozen GUIDE_SECTIONS id, in both directions', () => {
    expect([...sectionIds].sort()).toEqual([...GUIDE_SECTIONS].sort());
  });

  it('gives every section a label, a lede and real content', () => {
    for (const section of SECTIONS) {
      expect(section.label, section.id).toBeTruthy();
      expect(section.lede, section.id).toBeTruthy();
      // `?raw` returning '' is exactly what a renamed or deleted markdown file
      // looks like — the import succeeds and the tab is blank.
      expect(section.body.length, section.id).toBeGreaterThan(400);
      expect(section.body, section.id).toMatch(/^##? /m);
    }
  });

  it('falls back to the first section for an unknown or missing id', () => {
    expect(resolveSection(undefined).id).toBe(GUIDE_SECTIONS[0]);
    expect(resolveSection('nope').id).toBe(GUIDE_SECTIONS[0]);
  });

  it('names no private host, repo or path', () => {
    // The guide ships in a public repository. Placeholders only.
    //
    // `127.0.0.1` and `0.0.0.0` are deliberately allowed: they are the two
    // literals the security model is *about*, and a guide that could not print
    // them could not explain itself. Everything else that looks like an address
    // is somebody's actual machine.
    const addresses = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
    const ALLOWED = new Set(['127.0.0.1', '0.0.0.0']);
    // Whoever is running this, derived — never written down. A test that spells
    // out the name it forbids leaks it to everyone who reads the test.
    // A generic machine account is nobody's identity: on a CI box the username
    // is literally `runner`, and forbidding it would forbid the word this
    // guide's autopilot chapter is made of.
    const GENERIC = new Set(['runner', 'ci', 'build', 'agent', 'admin', 'user', 'root', 'ubuntu']);
    const local = [userInfo().username, hostname(), homedir()].filter(
      (s) => s.length >= 3 && !GENERIC.has(s.toLowerCase()),
    );
    const forbidden = [/\.ts\.net\/[a-z]/i, /\/Users\//, /\/home\/[a-z]/i];
    // As a token, never a bare substring: this machine's hostname is `Mac`, and
    // the guide is full of the word "machine". A leak names the identity alone.
    const names = (body: string, secret: string) =>
      new RegExp(`(?<![A-Za-z0-9])${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(
        body,
      );

    for (const section of SECTIONS) {
      for (const pattern of forbidden) {
        expect(section.body, `${section.id} matched ${pattern}`).not.toMatch(pattern);
      }
      for (const secret of local) {
        expect(names(section.body, secret), `${section.id} names local identity`).toBe(false);
      }
      for (const found of section.body.match(addresses) ?? []) {
        expect(ALLOWED.has(found), `${section.id} names ${found}`).toBe(true);
      }
      // Placeholder hostnames only — never a real tailnet.
      for (const host of section.body.match(/[\w.-]+\.ts\.net/g) ?? []) {
        expect(host, section.id).toBe('your-machine.your-tailnet.ts.net');
      }
    }
  });

  it('warns against the one flag that would undo the whole security model', () => {
    const mobile = SECTIONS.find((s) => s.id === 'mobile')!;
    expect(mobile.body).toMatch(/--host 0\.0\.0\.0/);
    expect(mobile.body).toMatch(/127\.0\.0\.1|loopback/);
  });
});

describe('the guide view', () => {
  it('renders the section named by the route, not the first one', async () => {
    // Asserted against the section's OWN first card rather than a heading
    // spelled out here. A test that names a heading turns editing prose into
    // breaking the build, which is the coupling the markdown split exists to
    // avoid — and it is how this test failed the first time the guide was
    // rewritten.
    renderGuide(['guide', 'mobile']);
    const panel = await screen.findByRole('tabpanel');
    const first = outlineOf('mobile').groups[0].cards[0];
    expect(within(panel).getByRole('heading', { name: first.title })).toBeTruthy();
  });

  it('marks that tab selected so a reload lands where you were', async () => {
    renderGuide(['guide', 'reference']);
    const tab = await screen.findByRole('tab', { name: 'Reference' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
  });

  it('renders one tab per section', async () => {
    renderGuide(['guide']);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs).toHaveLength(SECTIONS.length);
  });

  it('says what this console can actually do before describing what one can', async () => {
    renderGuide(['guide']);
    expect(await screen.findByText(/Runs are enabled on this console/i)).toBeTruthy();
  });

  it('renders markdown through the sanitizer — a table becomes a real table', async () => {
    renderGuide(['guide', 'reference']);
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getAllByRole('table').length).toBeGreaterThan(0);
  });

  it('paints the reference glossary words as their real badges, with the hover help', async () => {
    renderGuide(['guide', 'reference']);
    const panel = await screen.findByRole('tabpanel');

    // The decoration runs in an effect after the sanitizer fills the DOM.
    await waitFor(() => {
      const halted = [...panel.querySelectorAll('code')].find((el) => el.textContent === 'halted');
      expect(halted, 'the glossary names halted as inline code').toBeTruthy();
      // A halted run needs a person: the badge wears the needs-you state class
      // and paints by `--state`, never a colour of its own.
      expect(halted!.className, "painted as the run badge's own UI state").toContain('state-needs-you');
      expect(halted!.className).toContain('text-state');
      expect(halted!.getAttribute('title')).toMatch(/must not be automated past/);
    });

    // The eight UI states are words in the same glossary, and wear themselves.
    const done = [...panel.querySelectorAll('code')].find((el) => el.textContent === 'done');
    expect(done, 'done appears as inline code in the eight-states table').toBeTruthy();
    expect(done!.className).toContain('state-done');
    expect(done!.getAttribute('title')).toMatch(/Finished/);

    // A code word that is NOT a status stays a plain code span.
    const flag = [...panel.querySelectorAll('code')].find((el) => el.textContent?.startsWith('--allow'));
    if (flag) expect(flag.className).not.toContain('border-');
  });
});

describe('the section is cards, not a wall', () => {
  it('breaks the reference glossary into separate cards', async () => {
    // The section this refactor exists for: ~90 table rows under one heading.
    renderGuide(['guide', 'reference']);
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(6);
  });

  it('gives every card in every section an accessible name', async () => {
    for (const section of SECTIONS) {
      const { unmount } = renderGuide(['guide', section.id]);
      const panel = await screen.findByRole('tabpanel');
      const summaries = [...panel.querySelectorAll('summary')];
      expect(summaries.length, `${section.id} rendered no cards`).toBeGreaterThan(1);
      for (const summary of summaries) {
        expect(summary.textContent?.trim(), `${section.id}: a card with no name`).toBeTruthy();
      }
      unmount();
    }
  });

  it('renders a group band as a real heading above its cards', async () => {
    const banded = SECTIONS.find((s) => outlineOf(s.id).groups.some((g) => g.banded));
    if (!banded) return; // Every file is flat today; this guards the shape, not the content.
    renderGuide(['guide', banded.id]);
    const panel = await screen.findByRole('tabpanel');
    const group = outlineOf(banded.id).groups.find((g) => g.banded)!;
    expect(within(panel).getByRole('heading', { level: 2, name: group.title })).toBeTruthy();
  });

  it('opens every card on a desktop, except the bulky ones', async () => {
    renderGuide(['guide', 'reference']);
    const panel = await screen.findByRole('tabpanel');
    // No reference card is bulky — a glossary you cannot Cmd-F is not a
    // glossary — so every one of them is open at desktop width.
    for (const card of panel.querySelectorAll('details')) {
      expect((card as HTMLDetailsElement).open).toBe(true);
    }
  });

  it('opens only the first card on a phone', async () => {
    phone = true;
    renderGuide(['guide', 'reference']);
    const panel = await screen.findByRole('tabpanel');
    const cards = [...panel.querySelectorAll('details')] as HTMLDetailsElement[];
    expect(cards.length).toBeGreaterThan(1);
    // Asserted on `open`, not on a role query: whether jsdom exposes content
    // inside a closed `<details>` depends on its UA stylesheet, which is not a
    // thing to bet a test on.
    expect(cards[0].open).toBe(true);
    expect(cards.some((c) => !c.open)).toBe(true);
  });
});

describe('deep links to a card', () => {
  it('opens the card named by ?card=', async () => {
    const target = outlineOf('reference').groups[3].cards[0];
    renderGuide(['guide', 'reference'], { card: target.id });
    const panel = await screen.findByRole('tabpanel');
    const card = panel.querySelector<HTMLDetailsElement>(`#card-${CSS.escape(target.id)}`);
    expect(card, `no card with id ${target.id}`).toBeTruthy();
    expect(card!.open).toBe(true);
  });

  it('ignores an unknown ?card= rather than rendering nothing', async () => {
    // Card ids come from prose, so they are deliberately NOT frozen vocabulary
    // — which means a stale link has to degrade, not break.
    renderGuide(['guide', 'reference'], { card: 'no-such-card' });
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getAllByRole('table').length).toBeGreaterThan(0);
  });
});
