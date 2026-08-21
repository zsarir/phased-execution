/**
 * Heartbeat, Duration, RelativeTime — the clocks. What these tests hold: a
 * heartbeat pulses ONLY while the last beat is inside the stall threshold —
 * silence past it is drawn as the waiting state with the silence written out,
 * because a dot that keeps pulsing over a dead session is the lie this
 * console exists not to tell — and no beat at all reads "no heartbeat",
 * never live; a Duration is a real `<time>` with an ISO duration; a
 * RelativeTime carries the absolute instant and honestly dashes what it
 * cannot parse; and neither ticks unless told the thing is alive.
 *
 * axe runs on real setTimeout, so fake timers are installed inside the tests
 * that need a pinned clock and never around an axe smoke.
 */

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Duration, isoDuration } from './duration';
import { Heartbeat } from './heartbeat';
import { RelativeTime } from './relative-time';

const NOW = new Date('2026-08-21T12:00:00Z').getTime();

/** Pin the clock for one test; afterEach always restores. */
const pinClock = () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
};
afterEach(() => {
  vi.useRealTimers();
});

describe('Heartbeat', () => {
  const root = (container: HTMLElement) => container.firstElementChild as HTMLElement;

  it('a recent beat: "ago", pulsing, the running state', () => {
    pinClock();
    const { container } = render(<Heartbeat lastBeatAt={NOW - 60_000} />);
    const beat = root(container);
    expect(beat).toHaveTextContent(/ago/);
    expect(beat).toHaveClass('state-running');
    expect(beat.querySelector('[aria-hidden]')).toHaveClass('animate-pulse-soft');
  });

  it('silence past the threshold: "silent", waiting, no pulse', () => {
    pinClock();
    const { container } = render(<Heartbeat lastBeatAt={NOW - 12 * 60_000} />);
    const beat = root(container);
    expect(beat).toHaveTextContent(/silent/);
    expect(beat).toHaveClass('state-waiting');
    expect(beat.querySelector('[aria-hidden]')).not.toHaveClass('animate-pulse-soft');
  });

  it('the caller sets the stall threshold', () => {
    pinClock();
    const { container } = render(<Heartbeat lastBeatAt={NOW - 2 * 60_000} staleAfterMs={60_000} />);
    expect(root(container)).toHaveTextContent(/silent/);
  });

  it('no beat at all on a live lane reads "no heartbeat", never live', () => {
    pinClock();
    const { container } = render(<Heartbeat lastBeatAt={null} live />);
    const beat = root(container);
    expect(beat).toHaveTextContent('no heartbeat');
    expect(beat.querySelector('[aria-hidden]')).not.toHaveClass('animate-pulse-soft');
  });

  it('a settled record with nothing heard is a dash, not a claim', () => {
    pinClock();
    const { container } = render(<Heartbeat lastBeatAt={null} live={false} />);
    expect(root(container)).toHaveTextContent('—');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Heartbeat lastBeatAt={Date.now() - 30_000} label="lane 3 heartbeat" />);
    await expectNoAxeViolations(container);
  });
});

describe('Duration', () => {
  it('a settled length is a <time> with the ISO duration', () => {
    const { container } = render(<Duration ms={3_723_000} />);
    const time = container.querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('dateTime', 'PT1H2M3S');
    expect(time?.textContent).not.toBe('');
  });

  it('a missing length is an em-dash, not a zero', () => {
    const { container } = render(<Duration ms={null} />);
    expect(container).toHaveTextContent('—');
    expect(container.querySelector('time')).toBeNull();
  });

  it('isoDuration spells zero as PT0S', () => {
    expect(isoDuration(0)).toBe('PT0S');
    expect(isoDuration(3_723_000)).toBe('PT1H2M3S');
    expect(isoDuration(45_000)).toBe('PT45S');
  });

  it('ticks only while told the clock is live', () => {
    pinClock();
    render(<Duration since={NOW - 5_000} live={false} />);
    expect(vi.getTimerCount()).toBe(0);
    render(<Duration since={NOW - 5_000} live />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('has no axe violations', async () => {
    const { container } = render(<p>took <Duration ms={252_000} /></p>);
    await expectNoAxeViolations(container);
  });
});

describe('RelativeTime', () => {
  it('an ISO string renders a <time> carrying the absolute instant', () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    const { container } = render(<RelativeTime at={at} live={false} />);
    const time = container.querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('dateTime', at);
    expect(time).toHaveTextContent(/ago/);
  });

  it('a missing or unparseable instant is an em-dash, never "NaN ago"', () => {
    const { container: missing } = render(<RelativeTime at={undefined} />);
    expect(missing).toHaveTextContent('—');
    const { container: garbage } = render(<RelativeTime at="not-a-date" />);
    expect(garbage).toHaveTextContent('—');
    expect(garbage.textContent).not.toMatch(/NaN/);
  });

  it('live={false} never ticks — no timer leaks into the page', () => {
    pinClock();
    render(<RelativeTime at={NOW - 60_000} live={false} />);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('live re-reads the clock on the caller\'s cadence', () => {
    pinClock();
    render(<RelativeTime at={NOW - 60_000} live intervalMs={1_000} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it('has no axe violations', async () => {
    const { container } = render(<p>updated <RelativeTime at={Date.now() - 90_000} live={false} /></p>);
    await expectNoAxeViolations(container);
  });
});
