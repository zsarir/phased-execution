/**
 * The Phases tab: grouped by what a phase wants, not by its number.
 *
 * Four properties, each one a thing the old flat list could not do:
 *
 * 1. **The groups are the run page's.** Same `PHASE_GROUPS`, same `groupRows`,
 *    so "Needs you" cannot come to mean two things on two pages.
 * 2. **Done is collapsed and remembered.** On this estate Done is most of the
 *    plan, and a section that re-opens on every navigation is a section being
 *    re-collapsed rather than read.
 * 3. **The claim is on the row.** A `done` phase that nothing on disk backs is
 *    the single most useful thing this list can say, and the plan page did not
 *    say it at all. Absent `proof` renders nothing — a console whose server
 *    predates the model must not show a tick it was never told about.
 * 4. **The drawer is reused, not rebuilt** — `features/runs/phase-drawer`, and
 *    it asks for nothing until it is opened.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import type { PhaseView, PlanDetail } from '@/lib/api';
import { PhasesTab } from './phases-tab';

const { phaseDiagnosis, rulings, state } = vi.hoisted(() => ({
  phaseDiagnosis: vi.fn(),
  rulings: vi.fn(),
  state: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, phaseDiagnosis, rulings, state } };
});

const phase = (over: Partial<PhaseView> = {}): PhaseView =>
  ({
    phase: 1,
    title: 'Foundations',
    state: 'done',
    size: 'M',
    weight: 40_000,
    gated: false,
    bullets: [],
    ...over,
  }) as unknown as PhaseView;

const detail = (phases: PhaseView[]): PlanDetail =>
  ({ summary: { slug: 'demo' }, phases }) as unknown as PlanDetail;

const BOARD = [
  phase({ phase: 1, title: 'Foundations', state: 'done' }),
  phase({ phase: 2, title: 'Surface', state: 'ready' }),
  phase({ phase: 3, title: 'Cutover', state: 'waiting' }),
  phase({ phase: 4, title: 'Docs', state: 'stuck' }),
  phase({ phase: 5, title: 'Ship', state: 'in-progress' }),
];

function mount(view: PlanDetail) {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>
        <PhasesTab detail={view} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.mockResolvedValue({ allowTerminal: false, autopilot: true });
  // The whole shape the endpoint really sends — `workingTree` is not optional
  // on the wire, and a fixture that omits it tests a payload no server emits.
  phaseDiagnosis.mockResolvedValue({
    slug: 'demo',
    phase: 4,
    boardState: 'stuck',
    blockedOn: 'board',
    situation: null,
    evidence: [],
    workingTree: [],
    ways: [],
  });
  rulings.mockResolvedValue({ rulings: [] });
});

describe('the Phases tab', () => {
  it('groups by state, worst first, and drops the groups with nothing in them', () => {
    mount(detail(BOARD));
    const headings = screen.getAllByRole('button', { expanded: true }).map((b) => b.textContent ?? '');
    const shut = screen.getAllByRole('button', { expanded: false }).map((b) => b.textContent ?? '');
    const all = [...headings, ...shut].join('|');
    // The five that have rows, in `PHASE_GROUPS` order.
    expect(all).toMatch(/Needs you.*Running.*Ready.*Waiting.*Done/s);
  });

  it('drops a group with no phases in it rather than showing an empty one', () => {
    mount(detail([phase({ phase: 1, state: 'ready' })]));
    expect(screen.queryByText('Needs you')).toBeNull();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('opens with Done collapsed — and the collapse survives a remount', () => {
    const first = mount(detail(BOARD));
    // Collapsed by default: the card is not rendered at all.
    expect(screen.queryByText('Foundations')).toBeNull();

    const done = screen.getByRole('button', { name: /Done/ });
    expect(done).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(done);
    expect(screen.getByText('Foundations')).toBeInTheDocument();

    first.unmount();
    mount(detail(BOARD));
    // The choice is the operator's, and it is stored as the COLLAPSED ids — so
    // re-opening Done keeps it open across a navigation.
    expect(screen.getByText('Foundations')).toBeInTheDocument();
  });

  it('carries the claim-versus-evidence badge, and nothing when there is no proof', () => {
    mount(
      detail([
        phase({
          phase: 4,
          title: 'Docs',
          state: 'stuck',
          proof: {
            board: 'done',
            handoff: 'absent',
            verification: 'none',
            qa: 'off',
            evidenced: false,
            why: [],
          },
        } as unknown as Partial<PhaseView>),
        phase({ phase: 2, title: 'Surface', state: 'ready' }),
      ]),
    );
    expect(screen.getByText('claimed only')).toBeInTheDocument();
    // The `ready` row has no `proof` at all — and says nothing rather than
    // claiming the phase is fine.
    expect(screen.queryByText('evidenced')).toBeNull();
  });

  it("renders the run page's drawer per row, and asks for nothing until it is opened", async () => {
    mount(detail([phase({ phase: 4, title: 'Docs', state: 'stuck' })]));
    const drawer = screen.getByText('Why is this not done?');
    // The whole reason the drawer fetches on OPEN: `git status` plus two script
    // runs, per row, on a page where most rows are never opened.
    expect(phaseDiagnosis).not.toHaveBeenCalled();

    // jsdom does not fire `toggle` off a summary click, so open it directly.
    const details = drawer.closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(phaseDiagnosis).toHaveBeenCalledWith('demo', 4));
  });

  it('makes the number and the title links into the phase, and the card not one', () => {
    const { container } = mount(detail([phase({ phase: 2, title: 'Surface', state: 'ready' })]));
    const links = within(container).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toContain('#/plan/demo/phase/2');
    // Exactly two — the number and the title. A single anchor stretched over
    // the whole card is what left nowhere to put the drawer.
    expect(links.filter((a) => a.getAttribute('href') === '#/plan/demo/phase/2')).toHaveLength(2);
  });
});
