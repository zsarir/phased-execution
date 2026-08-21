/**
 * "Waiting on you" — errands, approvals, sign-ins, and nothing else.
 *
 * Every card on this operator's dashboard used to be a link, and the fix for
 * each one lived somewhere else in the console. Then the convergence loop
 * arrived and most of what the row shouted about stopped being a person's at
 * all: a halted run is classified and climbed, a stale claim is released or
 * taken over, a plan error is repaired — and each of those leaves ONE errand
 * when it cannot. So the row narrowed to what a person actually owns:
 *
 *  - **a permission card** — a session stopped dead until you answer;
 *  - **a sign-in** — no session can give it;
 *  - **the errands the ladder left** — one card per run, the ask in full, the
 *    remedies beside it;
 *  - **a stop nothing automatic will touch** — a run that opted out of
 *    auto-recovery, or a console that cannot run — said in the errand's shape.
 *
 * `demands()` is pure data by design, so what a card offers is assertable
 * without a server, a fetch mock or a click. Two properties keep it honest:
 * a remedy that cannot be taken is disabled with the reason, never hidden;
 * and a resolved run raises no card at all.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Errand, HealthIssue, RunState, TerminalSession } from '@/lib/api';
import { AttentionRow, demands, errandText, issueHref, type Demand, type DemandAction } from './now';

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

const errand = (over: Partial<Errand> = {}): Errand => ({
  phase: 4, situation: 'blocked-declared:credential', tried: [],
  need: 'The SSH key the session named.', how: 'Provide it where the handoff says, then Retry.',
  at: '2026-08-20T10:00:00.000Z',
  ...over,
});

/** A parked run the ladder left an errand on. */
const parkedWithErrand = (over: Partial<RunState> = {}): RunState => ({
  id: 'r9', slug: 'gamma', status: 'parked',
  halt: { at: '', reason: 'nothing left to run on its own — phase 4 is parked' },
  autoRecover: { attempts: 2 },
  recoveries: { '4': { attempts: 1, lastAt: '', errand: errand() } },
  ...over,
} as unknown as RunState);

const ids = (actions: DemandAction[]) => actions.map((a) => a.id);
const only = (items: Demand[], id: string) => items.find((i) => i.id === id)!;
/** By id, never by index — phase 4 inserted `start-recovery` between them. */
const act = (actions: DemandAction[], id: string) => actions.find((a) => a.id === id)!;

/* ------------------------------------------------------------------ *
 * Errands — the ladder's asks
 * ------------------------------------------------------------------ */

describe('an errand the ladder left', () => {
  it('raises one card per run, leading with the ask and carrying it whole', () => {
    const [card] = demands({ approvals: 0, runs: [parkedWithErrand()], allowRun: true, allowAgent: true });
    expect(card.id).toBe('errand-r9');
    expect(card.label).toBe('gamma — phase 4 needs you');
    // The situation in words, then need and how — ahead of the halt's own sentence.
    expect(card.detail).toMatch(/^Declared blocked · credential: phase 4 needs you — The SSH key the session named\. \(Provide it/);
    expect(card.errands).toEqual([errand()]);
    // The honest press after doing the errand: re-read the board, stand down
    // what the errand settled, continue or climb what is left. No agent button:
    // a parked run has no agent class (a credential is nothing an agent can
    // provide), and the shared model decides that, not this card.
    expect(ids(card.actions)).toEqual(['auto-recover', 'continue', 'dismiss']);
    expect(act(card.actions, 'auto-recover').kind).toBe('action');
    expect(card.actions.every((a) => a.target?.runId === 'r9' && a.target.slug === 'gamma')).toBe(true);
  });

  it('says how many phases ask when there are several, and folds them on the card', async () => {
    const run = parkedWithErrand({
      recoveries: {
        '4': { attempts: 1, lastAt: '', errand: errand() },
        '7': { attempts: 1, lastAt: '', errand: errand({ phase: 7, situation: 'gated-manual', need: 'A person to clear the manual gate.', how: 'Do the steps, then Approve.' }) },
      },
    } as Partial<RunState>);
    const [card] = demands({ approvals: 0, runs: [run], allowRun: true });
    expect(card.label).toBe('gamma — 2 phases need you');
    expect(card.detail).toMatch(/\+1 more$/);
    render(<AttentionRow items={[card]} />);
    // One shown, the rest behind a fold — and the ask is on the card, not a page away.
    expect(screen.getAllByTestId('errand')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Show all 2/ }));
    expect(await screen.findAllByTestId('errand')).toHaveLength(2);
    expect(screen.getByText(/A person to clear the manual gate/)).toBeInTheDocument();
  });

  it('leads with signing in when the errand is an auth wall', () => {
    const run = halted({
      id: 'r3', recoveries: {},
      errand: errand({ phase: 0, situation: 'resource-wall:auth', need: 'A signed-in Claude account for this run.', how: 'Run claude login, then Continue.' }),
    });
    const [card] = demands({ approvals: 0, runs: [run], allowRun: true, allowAgent: true });
    expect(card.label).toBe('alpha — needs you');
    expect(ids(card.actions)).toEqual(['login', 'recheck', 'continue', 'start-recovery', 'dismiss']);
    expect(act(card.actions, 'login').kind).toBe('action');
  });

  it('leads with continue-without-servers when the errand is an MCP wall', () => {
    const run = parkedWithErrand({
      recoveries: { '2': { attempts: 1, lastAt: '', errand: errand({ phase: 2, situation: 'mcp-unavailable', need: 'The server signed in.', how: 'Sign it in, or continue without it.' }) } },
    } as Partial<RunState>);
    const [card] = demands({ approvals: 0, runs: [run], allowRun: true });
    expect(ids(card.actions)).toEqual(['mcp-continue', 'continue', 'dismiss']);
  });

  it('disables what needs --allow-run, and says why, but never Dismiss', () => {
    // A halted run with an errand: its halt kind still earns an agent button,
    // which needs --allow-agent and says so — each remedy names ITS flag.
    const run = halted({ recoveries: { '6': { attempts: 1, lastAt: '', errand: errand({ phase: 6, situation: 'done-unrecorded', need: 'A complete handoff.', how: 'Run new-handoff.sh, or Resume the session.' }) } } });
    const [card] = demands({ approvals: 0, runs: [run] });
    expect(card.id).toBe('errand-r1');
    expect(act(card.actions, 'continue').disabled).toMatch(/--allow-run/);
    expect(act(card.actions, 'start-recovery').disabled).toMatch(/--allow-agent/);
    expect(act(card.actions, 'dismiss').disabled).toBeUndefined();
  });

  it('raises no card at all once the run is resolved — errand or not', () => {
    const resolved = parkedWithErrand({ resolved: { at: '2026-08-04T00:00:00.000Z', auto: true, reason: 'superseded — the board shows phase 4 done' } });
    expect(demands({ approvals: 0, runs: [resolved] })).toEqual([]);
    const dismissed = halted({ resolved: { at: '', auto: false, reason: 'dismissed by the operator' } });
    expect(demands({ approvals: 0, runs: [dismissed] })).toEqual([]);
  });

  it('errandText reads every errand, phase ones first, the run-level one last', () => {
    expect(errandText(parkedWithErrand())).toMatch(/^phase 4 needs you — The SSH key/);
    expect(errandText(halted())).toBeUndefined();
    const runLevel = halted({ recoveries: {}, errand: errand({ phase: 0, situation: 'resource-wall:auth', need: 'A signed-in account.', how: 'Sign in, then Continue.' }) });
    expect(errandText(runLevel)).toBe('A signed-in account. (Sign in, then Continue.)');
  });
});

/* ------------------------------------------------------------------ *
 * A halted run with NO errand
 * ------------------------------------------------------------------ */

describe('a stopped run the loop owns', () => {
  it('raises no card while the loop may still climb it — the errand is how it asks', () => {
    // Opted into auto-recovery, on a console that may run: the convergence
    // loop classifies and climbs, or writes the errand that brings it here.
    const run = halted({ autoRecover: { attempts: 2 } });
    expect(demands({ approvals: 0, runs: [run], allowRun: true, allowAgent: true })).toEqual([]);
  });

  it('raises the stop as your decision when the run opted out of auto-recovery', () => {
    const [card] = demands({ approvals: 0, runs: [halted()], allowRun: true, allowAgent: true });
    expect(card.id).toBe('halt-r1');
    expect(card.errands?.[0].need).toMatch(/auto-recovery is off for this run/);
    expect(ids(card.actions)).toEqual(['auto-recover', 'continue', 'start-recovery', 'dismiss']);
    expect(act(card.actions, 'continue').disabled).toBeUndefined();
    expect(card.actions.every((a) => a.target?.runId === 'r1' && a.target.slug === 'alpha')).toBe(true);
  });

  it('raises the stop when the console cannot run, disabled with the flag it needs', () => {
    const [card] = demands({ approvals: 0, runs: [halted({ autoRecover: { attempts: 2 } })] });
    expect(card.errands?.[0].need).toMatch(/read-only for runs/);
    expect(act(card.actions, 'continue').disabled).toMatch(/--allow-run/);
    expect(act(card.actions, 'start-recovery').disabled).toMatch(/--allow-agent/);
    expect(act(card.actions, 'dismiss').disabled).toBeUndefined();
  });

  it('is never raised for a stop the operator made', () => {
    expect(demands({ approvals: 0, runs: [halted({ stoppedBy: 'operator' })], allowRun: true })).toEqual([]);
  });

  it('leads with signing in when the halt is an auth failure', () => {
    const [card] = demands({ approvals: 0, runs: [authInterrupted()], allowRun: true, allowAgent: true });
    expect(ids(card.actions)).toEqual(['login', 'recheck', 'continue', 'start-recovery', 'dismiss']);
    expect(act(card.actions, 'login').kind).toBe('action');
    expect(act(card.actions, 'start-recovery').recoveryClass).toBe('auth-interrupted');
  });
});

/* ------------------------------------------------------------------ *
 * Sign-in, and what is NOT waiting on you any more
 * ------------------------------------------------------------------ */

describe('the sign-in card', () => {
  it('is raised on its own when the machine login is signed out', () => {
    const card = only(demands({ approvals: 0, runs: [], signedOut: true, allowRun: true }), 'sign-in');
    expect(ids(card.actions)).toEqual(['login', 'recheck']);
    expect(act(card.actions, 'login').disabled).toBeUndefined();
    expect(card.tone).toBe('bad');
  });

  it('treats a signed-out console as auth-blocked on a stop it owns, whatever the reason says', () => {
    const items = demands({ approvals: 0, runs: [halted()], allowRun: true, signedOut: true });
    expect(ids(only(items, 'halt-r1').actions)).toContain('login');
  });
});

describe('what the row no longer carries', () => {
  it('has no stale-claim, unread or plan-error cards — the loop releases, the inbox badges, the ladder repairs', () => {
    const items = demands({ approvals: 0, runs: [], allowRun: true });
    expect(items).toEqual([]);
    // The helpers those cards used still link an issue where it lives.
    const qaFail: HealthIssue = { slug: 'delta', severity: 'error', kind: 'qa-fail', message: 'Phase 10 QA recorded fail', phase: 10 };
    expect(issueHref(qaFail)).toBe('#/plan/delta/phase/10');
    expect(issueHref({ ...qaFail, phase: undefined })).toBe('#/plan/delta/handoffs');
    expect(issueHref({ slug: 'other', severity: 'error', kind: 'undefined-dep', message: 'x', phase: 3 })).toBe('#/plan/other/route');
  });

  it('still leads with permission cards', () => {
    const [first] = demands({ approvals: 2, runs: [parkedWithErrand()], allowRun: true });
    expect(first.id).toBe('approvals');
    expect(first.label).toBe('2 permission cards');
  });
});

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
    approvals: 0, runs: [halted()], allowRun: true, allowAgent: true, sessions, ...over,
  })[0];

  it('offers the session that is already working, not a second launch', () => {
    const action = act(cardFor([recovering()]).actions, 'start-recovery');
    expect(action.runningSessionId).toBe('sess-live');
    expect(action.label).toBe('Recovery running');
  });

  it('is somewhere to go rather than a capability — --allow-agent does not grey it', () => {
    const action = act(cardFor([recovering()], { allowAgent: false }).actions, 'start-recovery');
    expect(action.runningSessionId).toBe('sess-live');
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
    expect(screen.queryByRole('button', { name: /Recovery running/ })).toBeNull();
    expect(container.querySelectorAll('a button')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The row itself
 * ------------------------------------------------------------------ */

describe('the attention row', () => {
  it('renders a button per action and hands the press back with its target', () => {
    const onAction = vi.fn();
    const items = demands({ approvals: 0, runs: [parkedWithErrand()], allowRun: true });
    render(<AttentionRow items={items} onAction={onAction} />);

    screen.getByRole('button', { name: 'Dismiss' }).click();
    expect(onAction).toHaveBeenCalledTimes(1);
    const [demand, action] = onAction.mock.calls[0];
    expect(demand.id).toBe('errand-r9');
    expect(action.id).toBe('dismiss');
    expect(action.target).toEqual({ slug: 'gamma', runId: 'r9' });
  });

  it('renders the errand in place — need and how — not a page away', () => {
    render(<AttentionRow items={demands({ approvals: 0, runs: [parkedWithErrand()], allowRun: true })} />);
    const card = screen.getByTestId('errand');
    expect(card).toHaveTextContent('The SSH key the session named.');
    expect(card).toHaveTextContent('Provide it where the handoff says, then Retry.');
    expect(card).toHaveTextContent('Declared blocked · credential');
  });

  it('disables what cannot be done and explains it once for the card', () => {
    render(<AttentionRow items={demands({ approvals: 0, runs: [parkedWithErrand()] })} />);
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false);
    // Once per card, not once per button.
    expect(screen.getAllByText(/Restart the console with --allow-run/)).toHaveLength(1);
  });

  it('marks the action in flight as busy without freezing the others', () => {
    render(<AttentionRow items={demands({ approvals: 0, runs: [parkedWithErrand()], allowRun: true })} busy="errand-r9:continue" />);
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps the card heading a link — the buttons are siblings, not children of it', () => {
    const { container } = render(<AttentionRow items={demands({ approvals: 0, runs: [parkedWithErrand()], allowRun: true })} />);
    const link = screen.getByRole('link', { name: /gamma — phase 4 needs you/ });
    expect(link.getAttribute('href')).toBe('#/plan/gamma/run');
    // An anchor wrapping a button is invalid, and it is exactly why nothing
    // actionable could live in these cards before.
    expect(container.querySelectorAll('a button')).toHaveLength(0);
  });
});
