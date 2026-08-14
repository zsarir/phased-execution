/**
 * InfoTip — the TOUCH path for a blurb. Radix tooltips deliberately never
 * open from touch, so the blurb gets a dedicated tap target: tap opens,
 * outside pointer-down closes, aria-expanded tracks. Touch is faked via
 * vi.mock('@/lib/media') (see guide.test.tsx for why).
 */

import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
}));

import { InfoTip, TooltipProvider } from './tooltip';

function mount() {
  return render(
    <TooltipProvider delayDuration={0}>
      <InfoTip content="Resets this phase's record and continues the run." label="About Retry" />
      <button type="button">outside</button>
    </TooltipProvider>,
  );
}

describe('InfoTip on touch', () => {
  it('tap opens, outside pointer-down closes, aria-expanded tracks', async () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'About Retry' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await act(async () => { fireEvent.click(trigger); });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findAllByText(/Resets this phase/)).not.toHaveLength(0);

    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('a second tap on the trigger closes it', async () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'About Retry' });
    await act(async () => { fireEvent.click(trigger); });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await act(async () => { fireEvent.click(trigger); });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders nothing for an empty blurb', () => {
    const { container } = render(
      <TooltipProvider><InfoTip content="" /></TooltipProvider>,
    );
    expect(container.querySelector('button')).toBeNull();
  });
});
