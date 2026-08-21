/**
 * Meter, SegmentBar, Progress, MoneyAmount — the quantities. What these
 * tests hold: a Meter is a real `role="meter"` whose numbers are NOT clamped
 * even though its paint is (over the ceiling it turns the failed colour and
 * says "over"); a SegmentBar is one `role="img"` whose name reads the counts
 * out in words, worst first, each segment painted only by its state token;
 * Progress names the one number a reader wants ("N of M phases done"); and a
 * missing dollar amount is an em-dash, never `$0.00` — unrecorded is not free.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Meter } from './meter';
import { MoneyAmount } from './money';
import { Progress } from './progress';
import { SegmentBar } from './segment-bar';

describe('Meter', () => {
  const meterOf = (container: HTMLElement) => container.querySelector('[role="meter"]') as HTMLElement;

  it('is a role="meter" with the real numbers and a value text', () => {
    const { container } = render(<Meter value={62} max={100} label="Session budget" />);
    const meter = meterOf(container);
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(meter).toHaveAttribute('aria-valuetext', '62 %');
    expect(meter).toHaveAccessibleName('Session budget');
    expect(meter).toHaveClass('state-running');
  });

  it('over the ceiling: the fill turns failed and the title says so', () => {
    const { container } = render(<Meter value={1.2} max={1} label="Spend" valueText="$6.00 of $5.00" />);
    const meter = meterOf(container);
    expect(meter).toHaveClass('state-failed');
    expect(meter.getAttribute('title')).toContain('over');
    // The numbers are not clamped, only the paint is.
    expect(meter).toHaveAttribute('aria-valuenow', '1.2');
    const fill = meter.querySelector('span.block') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Meter value={0.4} label="Usage window">
      <p className="text-xs">resets at 14:00</p>
    </Meter>);
    await expectNoAxeViolations(container);
  });
});

describe('SegmentBar', () => {
  it('one role="img" whose name reads the counts out, worst first', () => {
    const { container } = render(<SegmentBar counts={{ done: 2, running: 1 }} />);
    const bar = container.querySelector('[role="img"]') as HTMLElement;
    const name = bar.getAttribute('aria-label') ?? '';
    expect(name).toContain('2 done');
    expect(name).toContain('1 running');
    // Worst first: running is drawn (and named) before done.
    expect(name.indexOf('1 running')).toBeLessThan(name.indexOf('2 done'));
    expect(name).toContain('3 of 3 phases');
  });

  it('segments are painted by their state class, never a colour of their own', () => {
    const { container } = render(<SegmentBar counts={{ done: 2, 'needs-you': 1 }} total={5} />);
    expect(container.querySelector('.state-done')).not.toBeNull();
    expect(container.querySelector('.state-needs-you')).not.toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('3 of 5');
  });

  it('no counts is said in words, not drawn as emptiness', () => {
    const { container } = render(<SegmentBar counts={{}} />);
    expect(container.querySelector('[role="img"]')).toHaveAttribute('aria-label', 'no phases');
  });

  it('has no axe violations', async () => {
    const { container } = render(<SegmentBar counts={{ done: 4, waiting: 2, 'needs-you': 1 }} label="phases" />);
    await expectNoAxeViolations(container);
  });
});

describe('Progress', () => {
  it('names the one number a reader wants', () => {
    const { container } = render(<Progress total={5} done={2} inProgress={1} ready={1} />);
    const bar = container.querySelector('[role="img"]');
    expect(bar).toHaveAttribute('aria-label', '2 of 5 phases done');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Progress total={11} done={6} stuck={1} />);
    await expectNoAxeViolations(container);
  });
});

describe('MoneyAmount', () => {
  it('a cost the runner has not recorded is an em-dash, never $0.00', () => {
    const { container } = render(<MoneyAmount usd={null} />);
    expect(container).toHaveTextContent('—');
    expect(container.textContent).not.toContain('$');
  });

  it('renders dollars and cents', () => {
    const { container } = render(<MoneyAmount usd={1.5} />);
    expect(container).toHaveTextContent('$1.50');
  });

  it('over budget: the failed colour, and the title says by what', () => {
    const { container } = render(<MoneyAmount usd={6} against={5} />);
    const amount = container.firstElementChild as HTMLElement;
    expect(amount).toHaveClass('text-failed');
    expect(amount.getAttribute('title')).toContain('over');
    expect(amount.getAttribute('title')).toContain('$5.00');
  });

  it('within budget it is not painted as trouble', () => {
    const { container } = render(<MoneyAmount usd={2} against={5} />);
    expect(container.firstElementChild).not.toHaveClass('text-failed');
  });

  it('has no axe violations', async () => {
    const { container } = render(<p>Spent <MoneyAmount usd={1.2} against={5} /> so far.</p>);
    await expectNoAxeViolations(container);
  });
});
