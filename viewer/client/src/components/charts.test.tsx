/**
 * The four charts.
 *
 * The property under test is the one the port exists to establish: **a chart
 * cannot be painted a colour the design system does not have.** The legacy
 * charts took a `color` string per segment and every call site passed
 * `var(--line-…)` by hand — which worked, and would equally have accepted
 * `#ff0000`. Here the palette is a closed set of tone names, so the guard is a
 * scan of the rendered output for any literal colour at all.
 *
 * That matters because a raw hex is invisible in one theme. Night and Paper have
 * different lightness for every state colour; a hardcoded green looks correct on
 * the board and unreadable on the map, and nobody flips the theme to check a
 * chart.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarList, Bars, CHART_TONES, Calendar, StackBar, toneVar } from './charts';

/** Anything that is a colour but not a token reference. */
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(/i;

/** Every `fill`, `stroke` and inline `background` in a rendered tree. */
function paints(container: HTMLElement): string[] {
  const out: string[] = [];
  for (const node of container.querySelectorAll<HTMLElement>('*')) {
    for (const attr of ['fill', 'stroke'] as const) {
      const value = node.getAttribute(attr);
      if (value) out.push(value);
    }
    const style = node.getAttribute('style');
    if (style) out.push(style);
  }
  return out;
}

const VELOCITY = [
  { week: '2026-W29', count: 2 },
  { week: '2026-W30', count: 5 },
  { week: '2026-W31', count: 0 },
];

const CALENDAR = [
  { date: '2026-08-01', count: 3 },
  { date: '2026-08-02', count: 1 },
];

describe('the chart palette', () => {
  it('resolves every tone to a --line-* custom property', () => {
    for (const tone of CHART_TONES) {
      expect(toneVar(tone)).toBe(`var(--line-${tone})`);
    }
  });

  it('paints Bars with tokens only', () => {
    const { container } = render(<Bars data={VELOCITY} />);
    const used = paints(container);
    expect(used.length).toBeGreaterThan(0);
    for (const value of used) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });

  it('paints the Calendar with tokens only, including the mixed intensities', () => {
    const { container } = render(<Calendar data={CALENDAR} />);
    const used = paints(container);
    // The heat cells are `color-mix(... var(--line-done) N%, var(--track))`,
    // which is the one place a percentage could tempt a literal.
    expect(used.some((v) => v.includes('color-mix'))).toBe(true);
    for (const value of used) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });

  it('paints BarList and StackBar with tokens only', () => {
    const { container } = render(
      <>
        <BarList items={[{ name: 'aws', value: 4 }, { name: 'hub', value: 1 }]} />
        <StackBar
          segments={[
            { label: 'done', value: 3, tone: 'done' },
            { label: 'ready', value: 1, tone: 'ready' },
          ]}
        />
      </>,
    );
    for (const value of paints(container)) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });
});

describe('the charts as charts', () => {
  it('marks the current week apart from the rest', () => {
    const { container } = render(<Bars data={VELOCITY} />);
    const bars = [...container.querySelectorAll('rect')];
    expect(bars).toHaveLength(VELOCITY.length);
    expect(bars.at(-1)!.getAttribute('fill')).toBe('var(--action)');
    expect(bars[0].getAttribute('fill')).toBe(toneVar('progress'));
  });

  it('gives a zero-count bar no height rather than a misleading minimum', () => {
    const { container } = render(<Bars data={[{ week: 'w', count: 0 }]} />);
    expect(container.querySelector('rect')!.getAttribute('height')).toBe('0');
  });

  it('scales BarList against its own maximum', () => {
    const { container } = render(
      <BarList items={[{ name: 'a', value: 10 }, { name: 'b', value: 5 }]} />,
    );
    const widths = [...container.querySelectorAll<HTMLElement>('span[style*="width"]')]
      .map((el) => el.style.width);
    expect(widths).toEqual(['100%', '50%']);
  });

  it('says so rather than rendering an empty rank when there is nothing to rank', () => {
    const { container } = render(<BarList items={[]} />);
    expect(container.textContent).toMatch(/Nothing recorded yet/);
  });

  it('divides a StackBar proportionally and labels every segment', () => {
    const { container } = render(
      <StackBar
        segments={[
          { label: 'done', value: 3, tone: 'done' },
          { label: 'ready', value: 1, tone: 'ready' },
        ]}
      />,
    );
    const widths = [...container.querySelectorAll<HTMLElement>('span[style*="width"]')]
      .map((el) => el.style.width);
    expect(widths).toEqual(['75%', '25%']);
    expect(container.textContent).toContain('done');
    expect(container.textContent).toContain('ready');
  });

  it('does not divide by zero when every segment is empty', () => {
    const { container } = render(
      <StackBar segments={[{ label: 'done', value: 0, tone: 'done' }]} />,
    );
    expect(container.querySelector<HTMLElement>('span[style*="width"]')!.style.width).toBe('0%');
  });

  it('gives every chart an accessible name — they are img roles, not decoration', () => {
    const { container } = render(
      <>
        <Bars data={VELOCITY} />
        <Calendar data={CALENDAR} />
      </>,
    );
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.getAttribute('aria-label')).toBeTruthy();
    }
  });
});
