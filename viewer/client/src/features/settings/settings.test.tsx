/**
 * The Settings destination, its Alerts section, and the chromeless source
 * picker — ported from `views/views.test.tsx` when Phase 11 deleted `views/`.
 *
 * What is worth asserting is the handful of properties the 3.0 rebuild
 * deliberately changed, plus the two that are invisible until they are wrong:
 *
 * - **Settings reports which client the server is serving.** The static root is
 *   picked per request, so this is the one fact on screen that says whether
 *   `client/dist` is live.
 * - **A section is an ADDRESS.** `#/settings/:section` is what makes a setting
 *   linkable from an errand, a guide page or a handoff; an unknown section is
 *   the index rather than a blank frame.
 * - **Every row is a link.** The 2.x views used `<button onClick=navigate>`
 *   throughout, which is invisible to a middle click and unreachable by a
 *   screen reader looking for links.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';
import type { ConsoleState } from '@/lib/api';

/* ------------------------------------------------------------------ *
 * One api mock for every view under test.
 * ------------------------------------------------------------------ */

// `vi.hoisted`, not plain `const`: a `vi.mock` factory is hoisted above every
// declaration in the file, so a top-level `const` it closes over is in its
// temporal dead zone when the factory runs. The failure reads as "Cannot access
// 'state' before initialization" from inside an unrelated module.
const { state, search, runs, notifications, browse, checkRoot, write, run, queue, runScopes } = vi.hoisted(
  () => ({
    state: vi.fn(),
    search: vi.fn(),
    runs: vi.fn(),
    notifications: vi.fn(),
    browse: vi.fn(),
    checkRoot: vi.fn(),
    write: vi.fn(),
    run: vi.fn(),
    queue: vi.fn(),
    runScopes: vi.fn(),
  }),
);

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      search,
      runs,
      notifications,
      browse,
      checkRoot,
      write,
      run,
      queue,
      runScopes,
      plans: vi.fn(async () => []),
      stats: vi.fn(async () => null),
      approvals: vi.fn(async () => []),
      auth: vi.fn(async () => ({ loggedIn: true, checkedAt: '2026-08-03T00:00:00Z' })),
      runTranscript: vi.fn(async () => []),
      policy: vi.fn(async () => {
        throw new Error('no policy endpoint');
      }),
      restartReadiness: vi.fn(async () => {
        throw new Error('no restart endpoint');
      }),
      push: vi.fn(async () => ({ publicKey: 'k', devices: [], categories: [] })),
    },
  };
});

const BASE_STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'not-built',
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  scriptsDir: '/scripts',
  sizing: { S: 15_000, M: 40_000, L: 90_000, budgetBig: 200_000, budgetHaiku: 40_000 },
  searchDocs: 42,
  supervisor: { detail: 'launchd' },
  repo: { available: true, branch: 'main', dirty: [] },
  recentRoots: [],
  unread: 0,
};

function mount(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue(BASE_STATE);
  search.mockResolvedValue({ query: '', total: 0, groups: [] });
  runs.mockResolvedValue([]);
  notifications.mockResolvedValue({
    items: [],
    total: 0,
    unread: 0,
    more: false,
    categories: [],
    devices: 0,
    outOfBand: { configured: false },
  });
  browse.mockResolvedValue({ path: '/repo', parent: '/', entries: [] });
  checkRoot.mockResolvedValue({
    path: '/repo',
    ok: false,
    label: 'repo',
    planCount: 0,
    handoffCount: 0,
    reason: 'No docs/plans directory here',
  });
  write.mockResolvedValue({ dryRun: true, command: 'new-handoff.sh demo 2 x complete' });
  run.mockResolvedValue({ run: null, history: [], eta: null });
  queue.mockResolvedValue({ max: 3, live: 0, queued: 0, throttledUntil: null, grants: [], entries: [] });
  runScopes.mockResolvedValue({ scopes: [] });
  // Browser-local and therefore sticky across cases in this file: a test that
  // opens the runs console would otherwise leave it open for the next one.
  setPrefs({ runsConsole: false });
  window.location.hash = '';
});
/* ------------------------------------------------------------------ *
 * Settings — the destination and its sections
 * ------------------------------------------------------------------ */

/** A parsed `#/settings[/section][?tab=]`, the shape the shell hands a page. */
function at(section?: string, query: Record<string, string> = {}) {
  const segments = section ? ['settings', section] : ['settings'];
  return { segments, query, path: segments.join('/') };
}

describe('settings', () => {
  it('lists every section, each with its own address', async () => {
    const { default: SettingsView } = await import('./index');
    const { SETTINGS_SECTIONS } = await import('./nav');
    mount(<SettingsView route={at()} />);

    const nav = await screen.findByRole('navigation', { name: /settings sections/i });
    for (const section of SETTINGS_SECTIONS) {
      const link = within(nav).getByRole('link', { name: new RegExp(section.title, 'i') });
      expect(link.getAttribute('href')).toBe(`#/settings/${section.id}`);
    }
  });

  it('renders one section when the address names one, and not the others', async () => {
    const { default: SettingsView } = await import('./index');
    mount(<SettingsView route={at('general')} />);

    expect(await screen.findByRole('heading', { name: 'General', level: 2 })).toBeTruthy();
    // Awaited, not read synchronously: the frame's heading paints before
    // `/api/state` answers, so the section renders its skeletons first — a
    // `getByText` here asserted against the loading state and passed only by
    // accident of ordering.
    expect(await screen.findByText('Phase weights')).toBeTruthy();
    // The Engine card is General's; the process facts are not.
    expect(screen.queryByText('Server code')).toBeNull();
  });

  it('falls back to the index rather than a blank frame on an unknown section', async () => {
    const { default: SettingsView } = await import('./index');
    mount(<SettingsView route={at('nonsense')} />);

    // The index, not an empty page: a typo in a bookmark lands somewhere useful.
    expect(await screen.findByRole('navigation', { name: /settings sections/i })).toBeTruthy();
  });

  it('says the client is not built when there is no dist', async () => {
    const { default: SettingsView } = await import('./index');
    mount(<SettingsView route={at('process')} />);
    expect(await screen.findByText(/is missing; run/i)).toBeTruthy();
  });

  it('reports a built client when the server is serving dist', async () => {
    state.mockResolvedValue({ ...BASE_STATE, staticRoot: 'dist' });
    const { default: SettingsView } = await import('./index');
    mount(<SettingsView route={at('process')} />);
    expect(await screen.findByText(/the built client/i)).toBeTruthy();
  });

  it('says so rather than guessing when the server predates the report', async () => {
    state.mockResolvedValue({ ...BASE_STATE, staticRoot: undefined });
    const { default: SettingsView } = await import('./index');
    mount(<SettingsView route={at('process')} />);
    expect(await screen.findByText(/predates the static-root report/i)).toBeTruthy();
  });

  it('offers no rule editor on a read-only console', async () => {
    const { default: SettingsView } = await import('./index');
    mount(<SettingsView route={at('permissions')} />);
    await screen.findByRole('heading', { name: 'Permissions', level: 2 });
    expect(screen.queryByText(/Add a rule/i)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Alerts — the section the notifications page became
 * ------------------------------------------------------------------ */

// The inbox half of the old page became the bell drawer in 3.0 — its cases live
// in `app/notifications/drawer.test.tsx`. What is left here is the plumbing, and
// the one property worth pinning is that the section still SAYS where the
// announcements went: `#/notifications/settings` is a link people already have,
// and it now resolves here.
describe('the alerts section', () => {
  it('renders the settings cards and points at the drawer', async () => {
    const { default: SettingsView } = await import('./index');
    mount(<SettingsView route={at('alerts')} />);

    expect(await screen.findByRole('heading', { name: 'Alerts', level: 2 })).toBeTruthy();
    const link = screen.getByRole('link', { name: /open the announcements/i });
    // The panel is named: the drawer opens on Needs you by default, and this
    // link is about the announcements.
    expect(link.getAttribute('href')).toBe('#/now?bell=1&panel=announcements');
  });
});

describe('the source picker', () => {
  it('refuses to enable Open until the path is actually a source directory', async () => {
    const { default: SourceView } = await import('./source');
    mount(<SourceView />);
    const open = await screen.findByRole('button', { name: 'Open' });
    expect(open.hasAttribute('disabled')).toBe(true);
    expect(await screen.findByText(/No docs\/plans directory here/i)).toBeTruthy();
  });

  it('enables Open and says what is in there once the path checks out', async () => {
    checkRoot.mockResolvedValue({
      path: '/repo',
      ok: true,
      label: 'repo',
      planCount: 7,
      handoffCount: 4,
      docsDir: '/repo/docs',
    });
    const { default: SourceView } = await import('./source');
    mount(<SourceView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(false),
    );
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('/repo/docs')).toBeTruthy();
  });

  it('marks a browsable directory that already holds plans', async () => {
    browse.mockResolvedValue({
      path: '/code',
      parent: '/',
      entries: [
        { name: 'hub', path: '/code/hub', hasDocs: true },
        { name: 'notes', path: '/code/notes', hasDocs: false },
      ],
    });
    const { default: SourceView } = await import('./source');
    mount(<SourceView />);

    const row = (await screen.findByText('hub')).closest('button')!;
    expect(within(row).getByText('plans')).toBeTruthy();
    const other = screen.getByText('notes').closest('button')!;
    expect(within(other).queryByText('plans')).toBeNull();
  });
});
