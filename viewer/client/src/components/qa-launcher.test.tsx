/**
 * The control that asks for a review — and the three states it is allowed to be in.
 *
 * The console could always record a QA result by hand; the thing it could not
 * do was get one. So the button is the whole feature from where an operator
 * stands, and the two properties that keep it honest are the ones P3 and P4
 * established for every other remedy on this console:
 *
 *  - **A capability that exists and cannot be used says which flag turns it on.**
 *    A greyed button with no explanation is a dead end in a different colour.
 *  - **"Already running" is somewhere to go, not a missing capability.** A live
 *    review is a link to it, never a disabled button — the operator pressing it
 *    a second time wants the session, not a refusal.
 *
 * And one this phase adds: **the console never shows a verdict nobody recorded.**
 * `pending` is a review that was asked for and never answered, so it is not a
 * chip beside `pass` and `fail`.
 */

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { QaDialog, QaButton, QaVerdict } from './qa-launcher';
import { canQa, isVerdict, liveQa, qaKey } from '@/lib/qa';

vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // The picker's own list needs a server; nothing here is about the picker.
  useSkills: () => ({ data: [] }),
}));

const target = { slug: 'alpha', phase: 2, title: 'cart api endpoint' };

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('the review button', () => {
  it('offers a review when the console may mint agent sessions', () => {
    render(<QaButton target={target} allowAgent />);
    const button = screen.getByRole('button', { name: /QA this phase/i });
    expect(button).not.toBeDisabled();
  });

  it('names the missing flag rather than vanishing', () => {
    render(<QaButton target={target} allowAgent={false} />);
    const button = screen.getByRole('button', { name: /QA this phase/i });
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/--allow-agent/);
  });

  it('becomes a link to the review already running, never a dead button', () => {
    render(<QaButton target={target} allowAgent runningSessionId="sess-9" />);
    const link = screen.getByRole('link', { name: /QA running/i });
    expect(link.getAttribute('href')).toBe('#/agent/sess-9');
    // Not a disabled control: what the operator wants next is that session.
    expect(screen.queryByRole('button', { name: /QA this phase/i })).toBeNull();
  });

  it('is still a link when agent sessions are disabled — the flag gates STARTING one', () => {
    render(<QaButton target={target} allowAgent={false} runningSessionId="sess-9" />);
    expect(screen.getByRole('link', { name: /QA running/i })).toBeTruthy();
  });
});

describe('turning QA on for the plan', () => {
  const off = { ...target, qaMode: 'off' };

  it('is offered, ticked, when the plan has QA off and the console may write', () => {
    mount(<QaDialog target={off} allowWrites onClose={() => {}} />);
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeDisabled();
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it('names the missing flag rather than failing on submit', () => {
    mount(<QaDialog target={off} allowWrites={false} onClose={() => {}} />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box).toBeDisabled();
    expect(box.checked).toBe(false);
    expect(box.getAttribute('title')).toMatch(/--allow-writes/);
    // …and it still says the review is worth running, which is the true part.
    expect(screen.getByText(/its verdict just gates nothing until then/i)).toBeTruthy();
  });

  it('is not asked about at all when the plan already runs QA', () => {
    mount(<QaDialog target={{ ...target, qaMode: 'on' }} allowWrites onClose={() => {}} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('warns that a recorded verdict is being re-judged, not overwritten', () => {
    mount(
      <QaDialog
        target={{ ...target, qaMode: 'on', qa: { result: 'fail', report: 'reports/phase-02-qa.md' } }}
        allowWrites
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/read that report first/i)).toBeTruthy();
  });
});

describe('the recorded verdict', () => {
  it('renders a real verdict, and links it to its report when there is one', () => {
    const { container } = render(
      <QaVerdict qa={{ result: 'fail', report: 'reports/phase-02-qa.md' }} href="#/plan/alpha/handoff/2" />,
    );
    expect(screen.getByText(/QA fail/)).toBeTruthy();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('#/plan/alpha/handoff/2');
  });

  it('shows nothing for a review that was asked for and never answered', () => {
    const { container } = render(<QaVerdict qa={{ result: 'pending' }} />);
    expect(container.textContent).toBe('');
    expect(render(<QaVerdict />).container.textContent).toBe('');
  });
});

describe('the offer rules', () => {
  it('is not offered for a phase nobody has started — there is no diff to read', () => {
    expect(canQa('waiting')).toBe(false);
    expect(canQa('done')).toBe(true);
    expect(canQa('ready')).toBe(true);
  });

  it('matches a live review by (slug, phase) and by nothing else', () => {
    const sessions = [
      { id: 'a', meta: { qa: { slug: 'alpha', phase: 2 } } },
      { id: 'b', exited: { code: 0 }, meta: { qa: { slug: 'alpha', phase: 5 } } },
    ];
    expect(liveQa(sessions, { slug: 'alpha', phase: 2 })?.id).toBe('a');
    // An ended session must let the chip turn back into a button.
    expect(liveQa(sessions, { slug: 'alpha', phase: 5 })).toBeUndefined();
    expect(liveQa(sessions, { slug: 'beta', phase: 2 })).toBeUndefined();
    expect(qaKey({ slug: 'alpha', phase: 2 })).not.toBe(qaKey({ slug: 'alpha', phase: 3 }));
  });

  it('counts only the three results that answer the question', () => {
    expect(['pass', 'fail', 'waived'].every(isVerdict)).toBe(true);
    expect(['pending', 'unknown', undefined].some(isVerdict)).toBe(false);
  });
});
