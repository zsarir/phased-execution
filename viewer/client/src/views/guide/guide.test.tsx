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
import { describe, expect, it, vi } from 'vitest';
import { GUIDE_SECTIONS } from '@shared/route-meta.js';
import { queryClientConfig } from '@/lib/queries';
import { SECTIONS, resolveSection, sectionIds } from './sections';
import GuideView from './index';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, state: vi.fn(async () => ({ autopilot: true, allowRun: true })) },
  };
});

function renderGuide(segments: string[]) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <GuideView route={{ segments, query: {}, path: segments.join('/') }} />
    </QueryClientProvider>,
  );
}

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
    const local = [userInfo().username, hostname(), homedir()].filter((s) => s.length >= 3);
    const forbidden = [/\.ts\.net\/[a-z]/i, /\/Users\//, /\/home\/[a-z]/i];
    // As a token, never a bare substring: this machine's hostname is `Mac`, and
    // the guide is full of the word "machine". A leak names the identity alone.
    const names = (body: string, secret: string) =>
      new RegExp(`(?<![A-Za-z0-9])${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i')
        .test(body);

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
    renderGuide(['guide', 'mobile']);
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: /Reaching the console from a phone/i }))
      .toBeTruthy();
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
});

  it('paints the reference glossary words as their real badges, with the hover help', async () => {
    renderGuide(['guide', 'reference']);
    const panel = await screen.findByRole('tabpanel');

    // The decoration runs in an effect after the sanitizer fills the DOM.
    await waitFor(() => {
      const halted = [...panel.querySelectorAll('code')].find((el) => el.textContent === 'halted');
      expect(halted, 'the glossary names halted as inline code').toBeTruthy();
      expect(halted!.className, 'painted with the run chip\'s own bad tone').toContain('border-blocked');
      expect(halted!.getAttribute('title')).toMatch(/must not be automated past/);
    });

    // The departures spellings too — the words the board actually shows.
    const departed = [...panel.querySelectorAll('strong')].find((el) => el.textContent === 'Departed');
    expect(departed, 'Departed appears bold in the board table').toBeTruthy();
    expect(departed!.className).toContain('state-done');
    expect(departed!.getAttribute('title')).toMatch(/finished and verified/);

    // A code word that is NOT a status stays a plain code span.
    const flag = [...panel.querySelectorAll('code')].find((el) => el.textContent?.startsWith('--allow'));
    if (flag) expect(flag.className).not.toContain('border-');
  });
