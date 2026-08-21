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
import {
  BarList,
  Bars,
  CHART_TONES,
  Calendar,
  LoadMeter,
  RouteStrip,
  RunStrip,
  StackBar,
  toneVar,
} from './charts';

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
  it('resolves every tone — the eight UI states — to a --status-* custom property', () => {
    expect([...CHART_TONES]).toEqual([
      'needs-you',
      'failed',
      'running',
      'verifying',
      'waiting',
      'queued',
      'skipped',
      'done',
    ]);
    for (const tone of CHART_TONES) {
      expect(toneVar(tone)).toBe(`var(--status-${tone})`);
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
    // The heat cells are `color-mix(... var(--status-done) N%, var(--track))`,
    // which is the one place a percentage could tempt a literal.
    expect(used.some((v) => v.includes('color-mix'))).toBe(true);
    for (const value of used) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });

  it('paints BarList and StackBar with tokens only', () => {
    const { container } = render(
      <>
        <BarList
          items={[
            { name: 'aws', value: 4 },
            { name: 'hub', value: 1 },
          ]}
        />
        <StackBar
          segments={[
            { label: 'done', value: 3, tone: 'done' },
            { label: 'next up', value: 1, tone: 'queued' },
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
    expect(bars[0].getAttribute('fill')).toBe(toneVar('running'));
  });

  it('gives a zero-count bar no height rather than a misleading minimum', () => {
    const { container } = render(<Bars data={[{ week: 'w', count: 0 }]} />);
    expect(container.querySelector('rect')!.getAttribute('height')).toBe('0');
  });

  it('scales BarList against its own maximum', () => {
    const { container } = render(
      <BarList
        items={[
          { name: 'a', value: 10 },
          { name: 'b', value: 5 },
        ]}
      />,
    );
    const widths = [...container.querySelectorAll<HTMLElement>('span[style*="width"]')].map(
      (el) => el.style.width,
    );
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
          { label: 'next up', value: 1, tone: 'queued' },
        ]}
      />,
    );
    const widths = [...container.querySelectorAll<HTMLElement>('span[style*="width"]')].map(
      (el) => el.style.width,
    );
    expect(widths).toEqual(['75%', '25%']);
    expect(container.textContent).toContain('done');
    expect(container.textContent).toContain('next up');
  });

  it('does not divide by zero when every segment is empty', () => {
    const { container } = render(<StackBar segments={[{ label: 'done', value: 0, tone: 'done' }]} />);
    expect(container.querySelector<HTMLElement>('span[style*="width"]')!.style.width).toBe('0%');
  });

  it('paints the LoadMeter and the RouteStrip with tokens only', () => {
    const { container } = render(
      <>
        <LoadMeter fraction={0.4} label="40%" description="40% of a session" />
        <RouteStrip
          phases={[
            { phase: 1, state: 'done' },
            { phase: 2, state: 'ready' },
          ]}
        />
      </>,
    );
    for (const value of paints(container)) expect(value, value).not.toMatch(LITERAL_COLOUR);
  });

  it('draws a load as a share of the bar, clamped for anything over budget', () => {
    const { container, rerender } = render(<LoadMeter fraction={0.4} label="40%" />);
    expect(container.querySelector<HTMLElement>('span[style*="width"]')!.style.width).toBe('40%');
    rerender(<LoadMeter fraction={1} label="over" />);
    expect(container.querySelector<HTMLElement>('span[style*="width"]')!.style.width).toBe('100%');
  });

  it('says so rather than drawing an empty meter when there is nothing to measure', () => {
    const { container } = render(<LoadMeter fraction={null} label="unsized" />);
    expect(container.querySelector('span[style*="width"]')).toBeNull();
    expect(container.textContent).toBe('unsized');
  });

  it('paints a state the engine has not taught it as the unknown state, never transparent', () => {
    // `var(--status-${state})` would interpolate an undeclared property for a
    // new engine word and paint the segment invisible — which reads as "this
    // phase does not exist" rather than "we do not know what this is". The
    // vocabulary's unknown state is `waiting`: never amber, never green.
    const { container } = render(<RouteStrip phases={[{ phase: 1, state: 'quantum-superposition' }]} />);
    const segment = container.querySelector<HTMLElement>('[title^="P1"]')!;
    expect(segment.style.background).toBe(toneVar('waiting'));
  });

  it('gives a strip one segment per phase and names the progress', () => {
    const { container } = render(
      <RouteStrip
        phases={[
          { phase: 1, state: 'done' },
          { phase: 2, state: 'done' },
          { phase: 3, state: 'ready' },
        ]}
      />,
    );
    const strip = container.querySelector('[role="img"]')!;
    expect(strip.getAttribute('aria-label')).toBe('3 phases, 2 done');
    expect(strip.children).toHaveLength(3);
  });

  it('paints a run strip with tokens only, including a status it has not been taught', () => {
    const { container } = render(
      <RunStrip
        phases={[
          { phase: 1, status: 'done' },
          { phase: 2, status: 'failed' },
          { phase: 3, status: 'quantum-superposition' },
        ]}
      />,
    );
    for (const value of paints(container)) expect(value, value).not.toMatch(LITERAL_COLOUR);
    // Same fallback the route strip makes: the unknown state says "we do not
    // know what this is", where an interpolated `var(--status-<new word>)`
    // would say nothing at all by painting the segment invisible.
    expect(container.querySelector<HTMLElement>('[title^="P3"]')!.style.background).toBe(toneVar('waiting'));
  });

  it('reads a run phase with the runner vocabulary, not the plan one', () => {
    // The two strips share exactly one word — `done`. A single table covering
    // both would have to answer what a `blocked` run phase is, and there is no
    // such thing.
    const { container } = render(
      <RunStrip
        phases={[
          { phase: 1, status: 'failed' },
          { phase: 2, status: 'parked' },
          { phase: 3, status: 'awaiting-verification' },
          { phase: 4, status: 'skipped' },
        ]}
      />,
    );
    const fills = [...container.querySelector('[role="img"]')!.children].map(
      (c) => (c as HTMLElement).style.background,
    );
    // `parked` is a queue of questions, not a failure — it needs a person,
    // never red; `awaiting-verification` likewise; `skipped` is its own word.
    expect(fills).toEqual([
      toneVar('failed'),
      toneVar('needs-you'),
      toneVar('needs-you'),
      toneVar('skipped'),
    ]);
  });

  it('counts a run strip by what actually finished', () => {
    const { container } = render(
      <RunStrip
        phases={[
          { phase: 1, status: 'done' },
          { phase: 2, status: 'skipped' },
          { phase: 3, status: 'failed' },
        ]}
      />,
    );
    // A skipped phase is not a done one, however the run ended.
    expect(container.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('3 phases, 1 done');
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
