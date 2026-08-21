/**
 * DataList — the virtualized long list. What these tests hold: only what is
 * near the viewport is in the DOM (a 50-row list renders a subset, never all
 * 50), yet assistive tech still hears a real list — `role="list"`,
 * `listitem` rows carrying `aria-setsize`/`aria-posinset` ("row N of 50"),
 * which are the attributes ARIA allows on list rows where the grid family
 * (`aria-rowcount`/`aria-rowindex`) is not; an empty list shows the caller's
 * empty node instead of a silent void; and a journal renders as articles.
 *
 * jsdom lays nothing out: this version of @tanstack/virtual measures the
 * scroller via `offsetHeight` and the rows via `getBoundingClientRect`, so
 * both are stubbed to real numbers here and restored after.
 */

import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { DataList } from './data-list';

const realRect = HTMLElement.prototype.getBoundingClientRect;
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const realOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

beforeAll(() => {
  // The scroller's viewport: 400px tall.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 600 });
  // A row measures 44px when the virtualizer asks.
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      height: 44,
      width: 600,
      top: 0,
      left: 0,
      bottom: 44,
      right: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight);
  if (realOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', realOffsetWidth);
});

const ITEMS = Array.from({ length: 50 }, (_, i) => ({ id: `row-${i}`, text: `Entry ${i}` }));

describe('DataList', () => {
  it('renders only a windowed subset of a 50-item list, as a real list', () => {
    render(
      <DataList
        items={ITEMS}
        keyOf={(item) => item.id}
        renderRow={(item) => <span>{item.text}</span>}
        label="Journal"
      />,
    );
    const list = screen.getByRole('list', { name: 'Journal' });
    const rows = list.querySelectorAll('[role="listitem"]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(50);
    // Rows say "N of 50" the way ARIA lets a partial list say it.
    expect(rows[0]).toHaveAttribute('aria-setsize', '50');
    expect(rows[0]).toHaveAttribute('aria-posinset', '1');
    expect(screen.getByText('Entry 0')).toBeInTheDocument();
    expect(screen.queryByText('Entry 49')).toBeNull();
  });

  it("an empty list shows the caller's empty node, not a void", () => {
    render(
      <DataList
        items={[]}
        keyOf={(item: { id: string }) => item.id}
        renderRow={(item) => <span>{item.id}</span>}
        empty={<span>Nothing logged yet.</span>}
        label="Journal"
      />,
    );
    expect(screen.getByText('Nothing logged yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('a journal role renders rows as articles', () => {
    render(
      <DataList
        items={ITEMS.slice(0, 12)}
        keyOf={(item) => item.id}
        renderRow={(item) => <span>{item.text}</span>}
        role="log"
        label="Run journal"
      />,
    );
    const log = screen.getByRole('log', { name: 'Run journal' });
    expect(log.querySelectorAll('[role="article"]').length).toBeGreaterThan(0);
    expect(log.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });

  it('keeps the header in ordinary flow above the scroller', () => {
    const { container } = render(
      <DataList
        items={ITEMS.slice(0, 3)}
        keyOf={(item) => item.id}
        renderRow={(item) => <span>{item.text}</span>}
        header={<h3>Today</h3>}
        label="Journal"
      />,
    );
    const header = screen.getByText('Today').parentElement as HTMLElement;
    expect(header.className).not.toMatch(/sticky/);
    // The header precedes the scroller in the same column.
    expect(container.firstElementChild?.firstElementChild).toBe(header);
  });

  it('has no axe violations, filled and empty', async () => {
    const { container } = render(
      <div>
        <DataList
          items={ITEMS}
          keyOf={(item) => item.id}
          renderRow={(item) => <span>{item.text}</span>}
          label="Journal"
        />
        <DataList
          items={[]}
          keyOf={(item: { id: string }) => item.id}
          renderRow={(item) => <span>{item.id}</span>}
          empty={<span>Nothing yet.</span>}
          label="Empty journal"
        />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
