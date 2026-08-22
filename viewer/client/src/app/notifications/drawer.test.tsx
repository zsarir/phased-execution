/**
 * The bell drawer — two panels.
 *
 * The announcements were a tab on a page until 3.0, so those are its cases,
 * moved: the store exists because a phone asleep and no tab open used to mean
 * the event had simply never happened, and every row has to say not only what
 * was announced but *what became of it* — a silent delivery failure being
 * exactly the thing that is invisible otherwise.
 *
 * What the move added is the open state. The drawer is `?bell=1` on whatever
 * route you are on, which is what lets `#/notifications` retire into it without
 * breaking a link, and what keeps the page you were reading underneath.
 *
 * Phase 8 added the second panel — the same `GET /api/inbox` rows Now leads
 * with, rendered by the same component. The default is Needs you, because the
 * bell carries a count and the count is of things still waiting; the
 * announcements panel is `?panel=announcements`, which is exactly what
 * `#/notifications` redirects to.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { parseHash, type Route } from '@/app/routes';
import { queryClientConfig } from '@/lib/queries';
import { NotificationsDrawer, deliverySummary, groupByDay } from './drawer';

const { notifications, markRead, inbox } = vi.hoisted(() => ({
  notifications: vi.fn(),
  markRead: vi.fn(),
  inbox: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, notifications, markNotificationsRead: markRead, inbox },
  };
});

const EMPTY = {
  items: [],
  total: 0,
  unread: 0,
  more: false,
  categories: [],
  devices: 0,
  outOfBand: { configured: false },
};

const record = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  at: new Date().toISOString(),
  category: 'approval',
  title: 'Permission needed',
  body: 'A session is blocked.',
  url: '/#/plan/demo/run',
  urgent: true,
  read: false,
  delivery: [{ device: 'd1', label: 'Mac · Chrome', outcome: 'sent', at: '' }],
  ...over,
});

const route = (hash: string): Route => parseHash(hash) as Route;

/** One inbox row, in the shape `server/inbox.ts` mints. */
const item = (over: Record<string, unknown> = {}) => ({
  id: 'errand:demo:4::verify-red',
  kind: 'errand',
  severity: 'needs-you',
  slug: 'demo',
  phase: 4,
  title: 'demo — phase 4 needs you',
  need: 'The SSH key the session named.',
  how: 'Provide it where the handoff says, then recover.',
  since: new Date().toISOString(),
  href: '#/plan/demo/run',
  actions: [
    { verb: 'recover', label: 'Recover & continue', endpoint: '/api/run/demo/recover', method: 'POST' },
  ],
  ...over,
});

/** The announcements panel is no longer the default — name it. */
const ANNOUNCEMENTS = '#/now?bell=1&panel=announcements';

function mount(hash = '#/now?bell=1') {
  const onNavigate = vi.fn();
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={hash} onNavigate={onNavigate}>
        <NotificationsDrawer route={route(hash)} />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return { ...view, onNavigate };
}

beforeEach(() => {
  vi.clearAllMocks();
  notifications.mockResolvedValue(EMPTY);
  markRead.mockResolvedValue({ changed: 1, unread: 0 });
  inbox.mockResolvedValue({ items: [], generatedAt: new Date().toISOString() });
});

describe('the open state is the URL', () => {
  it('renders nothing at all without ?bell=', () => {
    mount('#/now');
    expect(screen.queryByRole('dialog')).toBeNull();
    // And asks the server for nothing: a closed drawer has no business holding
    // a paged query open — of EITHER panel.
    expect(notifications).not.toHaveBeenCalled();
    expect(inbox).not.toHaveBeenCalled();
  });

  it('opens on ?bell= from any page, and closing leaves that page behind', async () => {
    const { onNavigate } = mount('#/plan/demo/run?bell=1');
    expect(await screen.findByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('#/plan/demo/run'));
  });
});

describe('what the drawer says about a delivery', () => {
  it('says nothing can reach you when no device and no command are set', async () => {
    mount(ANNOUNCEMENTS);
    expect(await screen.findByText(/Nothing can reach you out of band yet/i)).toBeTruthy();
  });

  it('renders a row as a link built from the server-supplied url', async () => {
    notifications.mockResolvedValue({
      ...EMPTY,
      items: [record()],
      total: 1,
      unread: 1,
      categories: [
        { id: 'approval', label: 'Permission needed', detail: 'x', byDefault: true, urgent: true },
      ],
      devices: 1,
    });
    mount(ANNOUNCEMENTS);

    const link = await screen.findByRole('link', { name: /Permission needed/ });
    // Never assembled here — `routeFor` on the server builds it, `toHash`
    // normalises the `/#/…` form a push payload carries.
    expect(link.getAttribute('href')).toBe('#/plan/demo/run');
    expect(screen.getByText('sent to 1')).toBeTruthy();
  });

  it('says a notification reached no device rather than implying it was delivered', async () => {
    notifications.mockResolvedValue({
      ...EMPTY,
      items: [
        record({
          id: 'n2',
          category: 'halted',
          title: 'Run halted',
          url: '/#/runs',
          read: true,
          delivery: [],
        }),
      ],
      total: 1,
      devices: 0,
      outOfBand: { configured: true },
    });
    mount(ANNOUNCEMENTS);
    expect(await screen.findByText('no device')).toBeTruthy();
  });

  it('marks a row read on the way to what it is about', async () => {
    notifications.mockResolvedValue({ ...EMPTY, items: [record()], total: 1, unread: 1, devices: 1 });
    const { onNavigate } = mount(ANNOUNCEMENTS);

    fireEvent.click(await screen.findByRole('link', { name: /Permission needed/ }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(['n1']));
    // A bare href cannot mark anything read, which is why the click is
    // intercepted — but the href stays so it can still be middle-clicked.
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('#/plan/demo/run'));
  });

  it('offers Mark all read only when something is unread', async () => {
    notifications.mockResolvedValue({ ...EMPTY, items: [record({ read: true })], total: 1, devices: 1 });
    mount(ANNOUNCEMENTS);
    const button = await screen.findByRole('button', { name: 'Mark all read' });
    expect(button).toBeDisabled();
  });
});

describe('the needs-you panel — the SAME rows Now leads with', () => {
  it('is the default panel, and it renders the inbox rather than the announcements', async () => {
    inbox.mockResolvedValue({ items: [item()], generatedAt: '' });
    mount();
    expect(await screen.findByText('demo — phase 4 needs you')).toBeTruthy();
    // The row carries the server's own remedy, with the server's own label.
    expect(screen.getByRole('button', { name: /Recover & continue/ })).toBeTruthy();
    // And the announcements query is not held open while its panel is closed.
    expect(notifications).not.toHaveBeenCalled();
  });

  it('switching panels is a navigation, so the address says which half is open', async () => {
    const { onNavigate } = mount();
    fireEvent.click(await screen.findByRole('button', { name: /Announcements/ }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(ANNOUNCEMENTS));
  });

  it('an action whose capability is off is offered, disabled, never hidden', async () => {
    inbox.mockResolvedValue({
      items: [
        item({
          actions: [
            {
              verb: 'recover',
              label: 'Recover & continue',
              endpoint: '/api/run/demo/recover',
              method: 'POST',
              flag: 'run',
            },
          ],
        }),
      ],
      generatedAt: '',
    });
    mount();
    const button = await screen.findByRole('button', { name: /Recover & continue/ });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toContain('--allow-run');
  });
});

describe('the two pure helpers', () => {
  it('names today and yesterday, and dates everything else', () => {
    const day = 86_400_000;
    const groups = groupByDay([
      record({ id: 'a', at: new Date().toISOString() }),
      record({ id: 'b', at: new Date(Date.now() - day).toISOString() }),
      record({ id: 'c', at: new Date(Date.now() - 6 * day).toISOString() }),
      record({ id: 'd', at: 'not a date' }),
    ] as never);
    const names = groups.map(([name]) => name);
    expect(names[0]).toBe('Today');
    expect(names[1]).toBe('Yesterday');
    expect(names[3]).toBe('Undated');
    // Every record lands in exactly one bucket.
    expect(groups.reduce((n, [, items]) => n + items.length, 0)).toBe(4);
  });

  it('counts a partial delivery as a failure, in the fewest words that are true', () => {
    expect(deliverySummary(record({ delivery: [] }) as never)).toEqual({
      text: 'no device',
      failed: false,
    });
    expect(
      deliverySummary(
        record({
          delivery: [
            { device: 'a', label: 'a', outcome: 'sent', at: '' },
            { device: 'b', label: 'b', outcome: 'failed', at: '' },
          ],
        }) as never,
      ),
    ).toEqual({ text: '1/2 not delivered', failed: true });
    expect(
      deliverySummary(record({ delivery: [{ device: 'a', label: 'a', outcome: 'sent', at: '' }] }) as never),
    ).toEqual({ text: 'sent to 1', failed: false });
  });
});
