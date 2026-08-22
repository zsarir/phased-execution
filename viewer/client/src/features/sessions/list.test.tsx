/**
 * The fold — four lists into one.
 *
 * `sessionRows` is where "every process this console owns or can see" stops
 * being a sentence and becomes data, so it is asserted without a pty, without a
 * socket and without a render: the ordering rule, the four kinds, and the two
 * things it deliberately does NOT do (draw a lane twice, or offer a Close on a
 * process this console does not own).
 *
 * ⚠️ The list itself is rendered here only for the row-level promises. Counting
 * ROWS in a rendering is what `journal.test.tsx` warns about — this list is not
 * virtualized, so it is safe here, but any future one that is will pass
 * vacuously (a virtualized scroller measures 0 tall in jsdom and honestly
 * reports nothing on screen).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ForeignSession, TerminalSession } from '@/lib/api';
import type { NowLane } from '@/features/now/model';
import { SessionList, sessionRows } from './list';

const NOW = Date.parse('2026-08-22T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const pty = (over: Partial<TerminalSession> & { id: string }): TerminalSession => ({
  label: over.id,
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 1,
  clients: 1,
  createdAt: NOW - 60_000,
  ...over,
});

const lane = (over: Partial<NowLane> & { phase: number }): NowLane =>
  ({
    key: `run-1#${over.phase}`,
    slug: 'alpha',
    planTitle: 'Alpha',
    runId: 'run-1',
    status: 'running',
    runStatus: 'running',
    costUsd: 0,
    attempts: 1,
    frozen: false,
    enriched: false,
    ...over,
  }) as NowLane;

const foreign = (over: Partial<ForeignSession> & { sessionId: string }): ForeignSession => ({
  kind: 'foreign',
  cwd: '/elsewhere',
  startedAt: at(30),
  lastSeen: at(1),
  turns: 3,
  presence: 'live',
  ...over,
});

describe('sessionRows', () => {
  it('folds all four kinds into one vocabulary', () => {
    const rows = sessionRows({
      terminals: [pty({ id: 'c1', label: 'Claude: hello', kind: 'claude' }), pty({ id: 's1' })],
      lanes: [lane({ phase: 3, title: 'Server B' })],
      foreign: [foreign({ sessionId: 'f1', owner: 'someone' })],
      now: NOW,
    });
    expect(rows.map((row) => row.kind)).toEqual(['lane', 'agent', 'shell', 'foreign']);
  });

  it('puts what is live above what is not, whatever kind it is', () => {
    const rows = sessionRows({
      terminals: [pty({ id: 'dead', exited: { code: 0 }, exitedAt: NOW - 1_000 }), pty({ id: 'alive' })],
      lanes: [lane({ phase: 1, status: 'queued' })],
      now: NOW,
    });
    // The queued lane is not live either, so the ONE live row leads — a list
    // sorted by kind alone would bury the shell you are typing in under eight
    // records of shells that exited yesterday.
    expect(rows[0]!.id).toBe('alive');
    expect(rows.filter((row) => row.live)).toHaveLength(1);
  });

  it('addresses a console-owned pty by id and sends everything else to its own page', () => {
    const rows = sessionRows({
      terminals: [pty({ id: 's1' })],
      lanes: [lane({ phase: 3 })],
      foreign: [foreign({ sessionId: 'f1', plan: { slug: 'beta', phase: 2, strong: true } })],
      now: NOW,
    });
    const by = (kind: string) => rows.find((row) => row.kind === kind)!;
    // The only rows with an `id` are the ones `#/sessions/:id` can open — which
    // is also what decides whether a Close button is offered.
    expect(by('shell').id).toBe('s1');
    expect(by('shell').href).toBe('#/sessions/s1');
    expect(by('lane').id).toBeUndefined();
    expect(by('lane').href).toContain('#/plan/alpha/run');
    expect(by('foreign').id).toBeUndefined();
    expect(by('foreign').href).toContain('#/plan/beta/run');
  });

  it('never draws a lane twice, however the registry reports it', () => {
    // The presence hook sees the console's OWN lane session too. Drawn from
    // both sources it appears as a lane and again as a foreign process, and
    // the two rows disagree about what can be done to it.
    const rows = sessionRows({
      lanes: [lane({ phase: 3, child: { sessionId: 'x9' } as NowLane['child'] })],
      foreign: [foreign({ sessionId: 'x9', plan: { slug: 'alpha', phase: 3, strong: true } })],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('lane');
  });

  it('is empty rather than undefined when the console can see nothing', () => {
    expect(sessionRows({ now: NOW })).toEqual([]);
  });
});

describe('<SessionList>', () => {
  const rows = () =>
    sessionRows({
      terminals: [pty({ id: 's1', label: 'Terminal 1' })],
      lanes: [lane({ phase: 3, title: 'Server B' })],
      now: NOW,
    });

  it('groups by kind, and renders no heading for a kind with nothing in it', () => {
    render(<SessionList rows={rows()} />);
    expect(screen.getByRole('region', { name: 'Shells' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Autopilot lanes' })).toBeInTheDocument();
    // Four headings over one shell is a page that looks broken on the console
    // most people run.
    expect(screen.queryByRole('region', { name: 'Agent sessions' })).toBeNull();
    expect(screen.queryByRole('region', { name: /other sessions/i })).toBeNull();
  });

  it('offers Close only where the console owns the process', () => {
    const closed: string[] = [];
    render(<SessionList rows={rows()} onClose={(id) => closed.push(id)} />);
    // One button, not two: a lane has no pty for this page to close, and a
    // Close beside it would be a button that answers 404.
    const buttons = screen.getAllByRole('button', { name: /^close /i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Close Terminal 1');
  });

  it('marks the open session, so the list beside a pane says which one it is', () => {
    render(<SessionList rows={rows()} activeId="s1" />);
    expect(screen.getByRole('link', { name: /Terminal 1/ })).toHaveAttribute('aria-current', 'true');
  });

  it('renders its own empty state rather than four blank headings', () => {
    render(<SessionList rows={[]} empty={<p>Nothing is running</p>} />);
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });
});
