/**
 * Skeleton, Empty, Spinner, Banner, StatusStack, KeyValue, CopyButton — the
 * feedback surfaces. What these tests hold: a Skeleton is invisible to
 * assistive tech (shape, not content); an Empty says why and offers a way
 * forward; a Spinner announces politely (`role="status"`); a StatusStack
 * owns the one slot for screen-level notes — worst first under the default
 * order, capped at `max` with the rest counted in words; a KeyValue is a
 * real `<dl>` that DROPS rows with no value rather than padding the page
 * with em-dashes; and a CopyButton answers "did that work?" where the
 * finger already is.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Button } from './button';
import { CopyButton } from './copy-button';
import { Empty, Skeleton, Spinner } from './feedback';
import { KeyValue } from './key-value';
import { Banner, StatusStack, type StatusNote } from './status-stack';

describe('Skeleton', () => {
  it('is hidden from assistive tech', () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Empty', () => {
  it('says what is missing, why, and what to do about it', () => {
    render(
      <Empty
        title="No plans yet"
        body="This repo has no docs/plans."
        action={<Button>Create one</Button>}
      />,
    );
    expect(screen.getByText('No plans yet')).toBeInTheDocument();
    expect(screen.getByText('This repo has no docs/plans.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create one' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Empty title="Nothing here" body="And that is fine." />);
    await expectNoAxeViolations(container);
  });
});

describe('Spinner', () => {
  it('announces politely, with the dot as decoration', () => {
    const { container } = render(<Spinner label="Loading the board…" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading the board…');
    expect(container.querySelector('[aria-hidden]')).toHaveClass('animate-spin');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Spinner label="Loading…" />);
    await expectNoAxeViolations(container);
  });
});

describe('Banner + StatusStack', () => {
  const NOTES: readonly StatusNote[] = [
    { id: 'ok', severity: 'ok', body: 'Run finished.' },
    { id: 'err', severity: 'error', body: 'Verification failed.' },
    { id: 'info', severity: 'info', body: 'QA is off for this plan.' },
    { id: 'warn', severity: 'warn', body: 'The server is running older code.' },
  ];

  it('a Banner is a status', () => {
    render(<Banner severity="warn">The build is stale.</Banner>);
    expect(screen.getByRole('status')).toHaveTextContent('The build is stale.');
  });

  it('orders worst-first under order="severity"', () => {
    const { container } = render(<StatusStack notes={NOTES} max={4} />);
    const bodies = [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent);
    expect(bodies).toEqual([
      'Verification failed.',
      'The server is running older code.',
      'QA is off for this plan.',
      'Run finished.',
    ]);
  });

  it('order="given" keeps the caller\'s declared priority', () => {
    const { container } = render(<StatusStack notes={NOTES} max={4} order="given" />);
    const bodies = [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent);
    expect(bodies[0]).toBe('Run finished.');
  });

  it('counts what it hides beyond max, in words', () => {
    render(<StatusStack notes={NOTES} max={2} />);
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByText('and 2 more notes')).toBeInTheDocument();
    expect(screen.queryByText('Run finished.')).toBeNull();
  });

  it('renders nothing for no notes', () => {
    const { container } = render(<StatusStack notes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('has no axe violations', async () => {
    const { container } = render(<StatusStack notes={NOTES} max={3} />);
    await expectNoAxeViolations(container);
  });
});

describe('KeyValue', () => {
  it('is a real <dl> that drops rows with no value', () => {
    const { container } = render(
      <KeyValue
        items={[
          ['Plan', 'console-frontend-redesign'],
          ['Lock', null],
          ['Gate', undefined],
          false,
          ['Phases', 11],
        ]}
      />,
    );
    expect(container.querySelector('dl')).not.toBeNull();
    expect(container.querySelectorAll('dt')).toHaveLength(2);
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.queryByText('Lock')).toBeNull();
  });

  it('renders nothing when every row is absent', () => {
    const { container } = render(<KeyValue items={[null, ['Lock', null]]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('has no axe violations', async () => {
    const { container } = render(<KeyValue items={[['Owner', 'mobin'], ['Lease', '18m left']]} />);
    await expectNoAxeViolations(container);
  });
});

describe('CopyButton', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubClipboard = () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...window.navigator, clipboard: { writeText } });
    return writeText;
  };

  it('copies and says so where the finger is', async () => {
    const writeText = stubClipboard();
    render(<CopyButton text="pbpaste me" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('Copied'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('pbpaste me');
  });

  it('resolves a text function at click time', async () => {
    const writeText = stubClipboard();
    render(<CopyButton text={() => Promise.resolve('fetched later')} label="Copy prompt" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('fetched later'));
  });

  it('has no axe violations', async () => {
    const { container } = render(<CopyButton text="x" label="Copy boot prompt" />);
    await expectNoAxeViolations(container);
  });
});
