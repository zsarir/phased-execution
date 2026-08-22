/**
 * The journal's two claims worth pinning:
 *
 *   1. **a permalink resolves even against a filter.** A link that silently
 *      showed nothing because a filter happened to be set would be worse than
 *      no link, and it is the failure mode a filter+permalink pair invites.
 *   2. **a phone nests no scroller.** The shell owns the ONE scroller; a
 *      second one inside it is what makes a page impossible to flick past. The
 *      phone rendering pays for that with an explicit page step instead.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { Journal, PAGE, filterEntries, journalHref, linkedSeq } from './journal';
import type { JournalEntry } from '@/lib/api';

vi.mock('@/lib/media', () => ({
  usePhone: () => phone,
  useNarrow: () => false,
  useMediaQuery: () => false,
}));

let phone = false;

function entry(seq: number, event: string, data?: Record<string, unknown>): JournalEntry {
  return {
    seq,
    time: new Date(Date.parse('2026-08-22T10:00:00Z') + seq * 1000).toISOString(),
    event,
    ...(data ? { data } : {}),
  };
}

beforeEach(() => {
  phone = false;
  window.location.hash = '#/plan/demo/run';
});
afterEach(() => {
  window.location.hash = '';
});

describe('the address of an entry', () => {
  it('reads `?j=` off the hash and puts it back without losing the rest', () => {
    expect(linkedSeq('#/plan/demo/run?j=42')).toBe(42);
    expect(linkedSeq('#/plan/demo/run')).toBeNull();
    // A non-numeric value is not an entry, and must not become NaN downstream.
    expect(linkedSeq('#/plan/demo/run?j=nonsense')).toBeNull();
    expect(journalHref(7, '#/plan/demo/run?tab=x')).toBe('#/plan/demo/run?tab=x&j=7');
  });
});

describe('filterEntries', () => {
  const entries = [entry(1, 'phase.board', { phase: 3 }), entry(2, 'phase.stall', { signal: 'silent' })];

  it('matches the event name and the flattened data', () => {
    expect(filterEntries(entries, 'stall', null).map((e) => e.seq)).toEqual([2]);
    expect(filterEntries(entries, 'silent', null).map((e) => e.seq)).toEqual([2]);
    expect(filterEntries(entries, '', null)).toHaveLength(2);
  });

  it('ALWAYS keeps the linked entry, even when the filter excludes it', () => {
    // The whole point: a permalink handed to somebody with a filter already
    // set must still resolve to the line it names.
    expect(filterEntries(entries, 'stall', 1).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('<Journal>', () => {
  it('shows newest first and links an entry by seq', () => {
    // Asserted in the PHONE rendering because that is the one that puts rows
    // in ordinary flow. jsdom gives the desktop scroller a height of zero, so
    // the virtualizer honestly reports that nothing is on screen and renders
    // no rows at all — see the desktop case below.
    phone = true;
    render(<Journal entries={[entry(1, 'run.start'), entry(2, 'phase.board')]} />);
    const links = screen.getAllByTitle('Copy a link to this entry');
    expect(links[0]).toHaveTextContent('#2');
    expect(links[1]).toHaveTextContent('#1');
  });

  it('filters, and says the buffer is not the whole story when nothing matches', () => {
    render(<Journal entries={[entry(1, 'run.start'), entry(2, 'phase.board')]} />);
    fireEvent.change(screen.getByLabelText('Filter the journal'), {
      target: { value: 'nothing-like-this' },
    });
    expect(screen.getByText(/Nothing matches that/)).toBeInTheDocument();
  });

  it('on a phone: no nested scroller, and an explicit step for older entries', () => {
    phone = true;
    const many = Array.from({ length: PAGE + 5 }, (_, i) => entry(i + 1, 'phase.board'));
    const { container } = render(<Journal entries={many} />);

    // The shell owns the one scroller. Nothing this component renders may
    // declare a second — that is the phone rule, and it is why the phone
    // rendering pages instead of virtualizing.
    expect(container.querySelector('[class*="overflow-y-auto"]')).toBeNull();

    const more = screen.getByRole('button', { name: /Show 5 older/ });
    expect(more).toBeInTheDocument();
    fireEvent.click(more);
    expect(screen.queryByRole('button', { name: /older/ })).not.toBeInTheDocument();
  });

  it('on a desktop: one bounded scroller, and far fewer rows than entries', () => {
    const many = Array.from({ length: 400 }, (_, i) => entry(i + 1, 'phase.board'));
    render(<Journal entries={many} />);
    // The virtualized list declares its own scroller — the thing the phone
    // rendering deliberately does not.
    expect(screen.getByRole('log', { name: 'Run journal' })).toBeInTheDocument();
    // And the DOM is not 400 rows. jsdom measures the scroller at zero height,
    // so the honest assertion is the bound, not a count: without
    // virtualization this is 400 regardless of viewport.
    expect(screen.queryAllByTitle('Copy a link to this entry').length).toBeLessThan(100);
  });
});
