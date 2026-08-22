/**
 * The three badges, and the one property they share: each renders NOTHING when
 * its fact is absent.
 *
 * That is not defensiveness. An older server does not send `proof` or
 * `liveness` at all, and the alternative to a blank cell is a badge asserting
 * something the console was never told — "evidenced" on a phase nobody
 * verified is exactly the claim this whole model exists to stop.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EvidenceLine, LivenessChip, RulingsChip } from './phase-row';
import type { EvidenceProof, LaneLiveness } from '@/lib/api';

const proof = (over: Partial<EvidenceProof> = {}): EvidenceProof => ({
  board: 'done',
  handoff: 'complete',
  verification: 'green',
  qa: 'off',
  evidenced: true,
  why: ['board: done', 'verification: green'],
  ...over,
});

describe('<EvidenceLine>', () => {
  it('badges a done claim that nothing backs', () => {
    render(<EvidenceLine proof={proof({ evidenced: false, verification: 'none', handoff: 'absent' })} />);
    expect(screen.getByText('claimed only')).toBeInTheDocument();
  });

  it('badges a done claim that is backed', () => {
    render(<EvidenceLine proof={proof()} />);
    expect(screen.getByText('evidenced')).toBeInTheDocument();
  });

  it('says NOTHING about a phase that is not claiming to be done', () => {
    // A `ready` phase has not claimed anything, so "not evidenced" would be a
    // warning on every plan that has not started yet.
    const { container } = render(<EvidenceLine proof={proof({ board: 'ready', evidenced: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('spells the four facts out in the drawer rendering', () => {
    render(<EvidenceLine verbose proof={proof({ qa: 'fail', evidenced: false })} />);
    expect(screen.getByText('Claimed versus evidenced')).toBeInTheDocument();
    expect(screen.getByText('QA failed')).toBeInTheDocument();
    expect(screen.getByText('the §Verification commands ran and passed')).toBeInTheDocument();
    // `skipped` and `human` are NOT failures — a command whose lead is not
    // installed, and a check only a person can answer.
    render(<EvidenceLine verbose proof={proof({ verification: 'skipped' })} />);
    expect(screen.getByText(/lead is not installed here/)).toBeInTheDocument();
  });
});

const lane = (over: Partial<LaneLiveness> = {}): LaneLiveness => ({
  phase: 3,
  lastOutputAt: new Date().toISOString(),
  turnsSinceLastTool: 1,
  commitsSinceStart: 2,
  treeDirty: false,
  ...over,
});

describe('<LivenessChip>', () => {
  it('renders nothing without a lane — which is most rows', () => {
    const { container } = render(<LivenessChip liveness={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the stall and how long it has been one', () => {
    render(
      <LivenessChip
        liveness={lane({
          stall: {
            signal: 'silent',
            since: new Date(Date.now() - 11 * 60_000).toISOString(),
            detail: 'Bash open 11m',
          },
        })}
      />,
    );
    expect(screen.getByText(/Silent/)).toBeInTheDocument();
  });

  it('shows the open tool on a healthy lane, because that is usually the answer', () => {
    render(
      <LivenessChip
        liveness={lane({ openTool: { id: 't1', name: 'Bash', since: new Date().toISOString() } })}
      />,
    );
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });
});

describe('<RulingsChip>', () => {
  it('counts, and disappears at zero', () => {
    const { container } = render(<RulingsChip count={0} />);
    expect(container).toBeEmptyDOMElement();
    render(<RulingsChip count={1} />);
    expect(screen.getByText('1 ruling')).toBeInTheDocument();
    render(<RulingsChip count={3} />);
    expect(screen.getByText('3 rulings')).toBeInTheDocument();
  });
});
