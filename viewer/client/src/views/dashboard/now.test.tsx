/**
 * "Waiting on you" — the row that used to be five dead ends.
 *
 * Every card on this operator's dashboard was a link, and the fix for each one
 * lived somewhere else in the console: the run page had the login flow the
 * auth-interrupted card needed, the write layer had the lock release the stale
 * claims card needed, the inbox had the bulk triage the unread card needed, and
 * the plan-error card rendered a hard-coded sentence — "A plan, handoff or
 * index disagrees with the board" — for an issue that was actually a recorded
 * QA failure.
 *
 * `demands()` is pure data by design, so what a card offers is assertable
 * without a server, a fetch mock or a click. The two properties that keep the
 * feature honest are here:
 *
 *  - **A remedy that cannot be taken is disabled with the reason**, not hidden
 *    and not silently broken. A greyed button with no explanation is the same
 *    dead end in a different colour.
 *  - **A resolved run raises no card at all** — that is the read-time resolver
 *    (`server/runner/state.ts`) reaching the surface it was built for.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HealthIssue, RunState, TerminalSession } from '@/lib/api';
import { AttentionRow, demands, issueHref, type Demand, type DemandAction } from './now';

const halted = (over: Partial<RunState> = {}): RunState => ({
  id: 'r1', slug: 'alpha', status: 'halted',
  halt: { at: '2026-08-03T02:55:04.476Z', reason: 'the session for phase 6 ended cleanly but the board still reads "ready"', phase: 6 },
  ...over,
} as unknown as RunState);

const authInterrupted = (over: Partial<RunState> = {}): RunState => ({
  id: 'r2', slug: 'beta', status: 'interrupted',
  halt: { at: '', reason: 'authentication failed — the session\'s Claude login is expired or signed out; sign that account in again, then continue the run', phase: 14 },
  ...over,
} as unknown as RunState);

const ids = (actions: DemandAction[]) => actions.map((a) => a.id);
const only = (items: Demand[], id: string) => items.find((i) => i.id === id)!;
/** By id, never by index — phase 4 inserted `start-recovery` between them. */
const act = (actions: DemandAction[], id: string) => actions.find((a) => a.id === id)!;

/* ------------------------------------------------------------------ *
 * A halted run
 * ------------------------------------------------------------------ */

describe('a stopped run', () => {
  it('offers Recover & continue first, then Continue, the AI repair and Dismiss', () => {
    const [card] = demands({
      approvals: 0, runs: [halted()], unread: 0, expiredLocks: [], allowRun: true, allowAgent: true,
    });
    // Continue re-runs the phase as it was; the recovery reads why it broke.
    // Dismiss stays last — it resolves the card without resolving the run.
    expect(ids(card.actions)).toEqual(['auto-recover', 'continue', 'start-recovery', 'dismiss']);
    expect(act(card.actions, 'continue').disabled).toBeUndefined();
    // All of them name the run they act on — a plan that has run since has more
    // than one, and "the latest" is not the one whose card you pressed.
    expect(card.actions.every((a) => a.target?.runId === 'r1' && a.target.slug === 'alpha')).toBe(true);
  });

  it('disables Continue without --allow-run, and says why, but never Dismiss', () => {
    const [card] = demands({ approvals: 0, runs: [halted()], unread: 0, expiredLocks: [] });
    expect(act(card.actions, 'continue').disabled).toMatch(/--allow-run/);
    // Each remedy names the capability IT needs, not the console's worst gate.
    expect(act(card.actions, 'start-recovery').disabled).toMatch(/--allow-agent/);
    // Deciding a card no longer deserves attention is judgement, not a
    // capability — a read-only console that cannot even do that is the dead end.
    expect(act(card.actions, 'dismiss').disabled).toBeUndefined();
  });

  it('leads with signing in when the halt is an auth failure', () => {
    const [card] = demands({
      approvals: 0, runs: [authInterrupted()], unread: 0, expiredLocks: [], allowRun: true, allowAgent: true,
    });
    // Continuing before signing in is a session that reports success, spends a
    // turn and changes nothing — which is exactly how this run stopped.
    expect(ids(card.actions)).toEqual(['login', 'recheck', 'continue', 'start-recovery', 'dismiss']);
    expect(act(card.actions, 'login').kind).toBe('action');
    expect(act(card.actions, 'continue').kind).toBe('default');
    // And the recovery offered is the auth one — the server refuses to mint it
    // while signed out, which is the whole point of naming the class here.
    expect(act(card.actions, 'start-recovery').recoveryClass).toBe('auth-interrupted');
  });

  it('treats a signed-out console as auth-blocked whatever the reason says', () => {
    const [card] = demands({
      approvals: 0, runs: [halted()], unread: 0, expiredLocks: [], allowRun: true, signedOut: true,
    });
    expect(ids(card.actions)).toContain('login');
  });

  it('raises no card at all once the run is resolved', () => {
    const resolved = halted({
      resolved: { at: '2026-08-04T00:00:00.000Z', auto: true, reason: 'superseded — the board shows phase 6 done' },
    });
    expect(demands({ approvals: 0, runs: [resolved], unread: 0, expiredLocks: [] })).toEqual([]);
    // …and a run someone dismissed by hand is just as quiet.
    const dismissed = halted({ resolved: { at: '', auto: false, reason: 'dismissed by the operator' } });
    expect(demands({ approvals: 0, runs: [dismissed], unread: 0, expiredLocks: [] })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Stale claims
 * ------------------------------------------------------------------ */

describe('stale claims', () => {
  it('offers one release when there is one lock', () => {
    const card = only(demands({
      approvals: 0, runs: [], unread: 0, allowWrites: true,
      expiredLocks: [{ slug: 'alpha', phase: 1 }],
    }), 'locks');
    // Release frees the phase; taking it over also does the work. Offered only
    // for a single unambiguous claim — see the bulk case below.
    expect(ids(card.actions)).toEqual(['release', 'start-recovery']);
    expect(card.actions[0].target).toEqual({ slug: 'alpha', phase: 1 });
    expect(card.actions[0].label).toContain('alpha P1');
    expect(act(card.actions, 'start-recovery').recoveryClass).toBe('stale-claim-takeover');
  });

  it('offers bulk AND per-lock when there are several', () => {
    const card = only(demands({
      approvals: 0, runs: [], unread: 0, allowWrites: true,
      expiredLocks: [
        { slug: 'alpha', phase: 1 },
        { slug: 'beta', phase: 2 },
        { slug: 'gamma', phase: 8 },
      ],
    }), 'locks');
    // All-or-nothing is not triage: one of three stale claims may be one you
    // want to leave alone.
    expect(ids(card.actions)).toEqual(['release-all', 'release', 'release', 'release']);
    expect(card.actions[0].label).toBe('Release all 3');
    expect(card.actions.slice(1).map((a) => a.target?.phase)).toEqual([1, 2, 8]);
  });

  it('needs --allow-writes, and says so on every release', () => {
    const card = only(demands({
      approvals: 0, runs: [], unread: 0, expiredLocks: [{ slug: 'beta', phase: 3 }],
    }), 'locks');
    expect(card.actions[0].disabled).toMatch(/--allow-writes/);
  });
});

/* ------------------------------------------------------------------ *
 * Unread, and the plan errors
 * ------------------------------------------------------------------ */

describe('triage from the dashboard', () => {
  it('offers mark-all-read, with no flag needed', () => {
    const card = only(demands({ approvals: 0, runs: [], unread: 182, expiredLocks: [] }), 'unread');
    expect(ids(card.actions)).toEqual(['mark-read']);
    expect(card.actions[0].disabled).toBeUndefined();
    expect(card.label).toBe('182 unread notifications');
  });
});

describe('the plan-error card', () => {
  const qaFail: HealthIssue = {
    slug: 'delta', severity: 'error', kind: 'qa-fail',
    message: 'Phase 10 QA recorded fail — dependents stay blocked', phase: 10,
  };
  const dep: HealthIssue = {
    slug: 'other', severity: 'error', kind: 'undefined-dep',
    message: 'Phase 3 depends on 9, which is not in the table', phase: 3,
  };
  const warning: HealthIssue = { slug: 'other', severity: 'warning', kind: 'orphan', message: 'no plan file' };

  it('says what the real issue is instead of a hard-coded sentence', () => {
    const card = only(demands({
      approvals: 0, runs: [], unread: 0, expiredLocks: [], issues: [qaFail, warning],
    }), 'errors');
    expect(card.detail).toContain('QA recorded fail');
    expect(card.detail).not.toContain('disagrees with the board');
    // Only errors — a warning is true, and nothing is waiting on it.
    expect(card.issues).toEqual([qaFail]);
    expect(card.label).toBe('1 plan error');
  });

  it('stays hidden when nothing is an error', () => {
    const items = demands({ approvals: 0, runs: [], unread: 0, expiredLocks: [], issues: [warning] });
    expect(items.find((i) => i.id === 'errors')).toBeUndefined();
  });

  it('links each issue where it actually lives', () => {
    expect(issueHref(qaFail)).toBe('#/plan/delta/phase/10');
    expect(issueHref(dep)).toBe('#/plan/other/route');
    expect(issueHref({ ...qaFail, phase: undefined })).toBe('#/plan/delta/handoffs');
  });

  it('expands the list when there is more than one', async () => {
    const card = only(demands({
      approvals: 0, runs: [], unread: 0, expiredLocks: [], issues: [qaFail, dep],
    }), 'errors');
    render(<AttentionRow items={[card]} />);

    // Collapsed: the summary names the plans, not the messages.
    expect(screen.queryByText(/depends on 9/)).toBeNull();
    screen.getByRole('button', { name: /Show all 2/ }).click();
    expect(await screen.findByText(/depends on 9/)).toBeTruthy();
    expect(screen.getByText(/QA recorded fail/)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * The row itself
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * A recovery already running
 * ------------------------------------------------------------------ */

describe('a recovery already running', () => {
  const link = (over: Record<string, unknown> = {}) =>
    ({ kind: 'halted-verification', slug: 'alpha', phase: 6, ...over });

  const recovering = (over: Partial<TerminalSession> = {}): TerminalSession => ({
    id: 'sess-live', label: 'Recover alpha P6', kind: 'claude',
    cwd: '/w', shell: 'claude', cols: 80, rows: 24, pid: 4242, clients: 0, createdAt: 0,
    meta: { intent: 'recovery', recovery: link() },
    ...over,
  } as unknown as TerminalSession);

  const cardFor = (sessions: TerminalSession[], over: { allowAgent?: boolean } = {}) => demands({
    approvals: 0, runs: [halted()], unread: 0, expiredLocks: [], allowRun: true,
    allowAgent: true, sessions, ...over,
  })[0];

  it('offers the session that is already working, not a second launch', () => {
    const action = act(cardFor([recovering()]).actions, 'start-recovery');
    expect(action.runningSessionId).toBe('sess-live');
    expect(action.label).toBe('Recovery running');
  });

  it('is somewhere to go rather than a capability — --allow-agent does not grey it', () => {
    const action = act(cardFor([recovering()], { allowAgent: false }).actions, 'start-recovery');
    expect(action.runningSessionId).toBe('sess-live');
    // The gate applies to STARTING one. Greying this would hide the very thing
    // the operator now wants, which is that session's terminal.
    expect(action.disabled).toBeUndefined();
  });

  it('is judged by (slug, phase) — an ended session or another target is not a duplicate', () => {
    const cases: [string, TerminalSession][] = [
      ['it already ended', recovering({ exited: { code: 0 } })],
      ['another phase', recovering({ meta: { intent: 'recovery', recovery: link({ phase: 2 }) } })],
      ['another plan', recovering({ meta: { intent: 'recovery', recovery: link({ slug: 'beta' }) } })],
      ['not a recovery at all', recovering({ meta: { intent: 'plan' } })],
    ];
    for (const [why, session] of cases) {
      const action = act(cardFor([session]).actions, 'start-recovery');
      expect(action.runningSessionId, why).toBeUndefined();
      expect(action.label, why).not.toBe('Recovery running');
    }
  });

  it('renders as a link to the session, and keeps the card free of nested controls', () => {
    const { container } = render(<AttentionRow items={[cardFor([recovering()])]} />);
    const chip = screen.getByRole('link', { name: /Recovery running/ });
    expect(chip.getAttribute('href')).toBe('#/agent/sess-live');
    // A disabled button here would be the dead end this replaced.
    expect(screen.queryByRole('button', { name: /Recovery running/ })).toBeNull();
    expect(container.querySelectorAll('a button')).toHaveLength(0);
  });
});

describe('the attention row', () => {
  it('renders a button per action and hands the press back with its target', () => {
    const onAction = vi.fn();
    const items = demands({
      approvals: 0, runs: [halted()], unread: 0, expiredLocks: [], allowRun: true,
    });
    render(<AttentionRow items={items} onAction={onAction} />);

    screen.getByRole('button', { name: 'Dismiss' }).click();
    expect(onAction).toHaveBeenCalledTimes(1);
    const [demand, action] = onAction.mock.calls[0];
    expect(demand.id).toBe('halt-r1');
    expect(action.id).toBe('dismiss');
    expect(action.target).toEqual({ slug: 'alpha', runId: 'r1' });
  });

  it('disables what cannot be done and explains it once for the card', () => {
    const items = demands({ approvals: 0, runs: [halted()], unread: 0, expiredLocks: [] });
    render(<AttentionRow items={items} />);

    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false);
    // Once per card, not once per button.
    expect(screen.getAllByText(/Restart the console with --allow-run/)).toHaveLength(1);
  });

  it('marks the action in flight as busy without freezing the others', () => {
    const items = demands({
      approvals: 0, runs: [halted()], unread: 0, expiredLocks: [], allowRun: true,
    });
    render(<AttentionRow items={items} busy="halt-r1:continue" />);
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps the card heading a link — the buttons are siblings, not children of it', () => {
    const items = demands({
      approvals: 0, runs: [halted()], unread: 0, expiredLocks: [], allowRun: true,
    });
    const { container } = render(<AttentionRow items={items} />);
    const link = screen.getByRole('link', { name: /alpha halted/ });
    expect(link.getAttribute('href')).toBe('#/plan/alpha/run');
    // An anchor wrapping a button is invalid, and it is exactly why nothing
    // actionable could live in these cards before.
    expect(container.querySelectorAll('a button')).toHaveLength(0);
  });
});
