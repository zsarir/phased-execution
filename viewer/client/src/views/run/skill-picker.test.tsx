/**
 * The skill picker, where a machine-level default has to be visible.
 *
 * A box ticked by something the operator never touched is the failure mode of
 * any "default on" feature: it looks like a bug, or worse, goes unnoticed until
 * a session invokes something nobody asked for. The badge is the whole fix — it
 * says *why* the box is ticked, and that unticking it is a decision about this
 * run rather than a change to the console.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SkillPicker } from './skill-picker';
import type { SkillInfo } from '@/lib/api';

const SKILLS: SkillInfo[] = [
  { id: 'graph-tool', name: 'graph-tool', description: 'keeps an index', source: 'personal', path: '/x' },
  { id: 'investigate', name: 'investigate', description: 'systematic debugging', source: 'personal', path: '/y' },
];

function mount(props: Partial<Parameters<typeof SkillPicker>[0]> = {}) {
  return render(
    <SkillPicker
      skills={SKILLS}
      chosen={[]}
      onChange={vi.fn()}
      {...props}
    />,
  );
}

describe('SkillPicker default badges', () => {
  it('marks a chosen skill that is on by default for this console', () => {
    mount({ chosen: ['graph-tool'], defaultSkills: ['graph-tool'] });
    const chip = screen.getByRole('button', { name: 'Remove graph-tool' });
    expect(within(chip).getByText('default')).toBeTruthy();
  });

  it('leaves a skill the operator chose themselves unmarked', () => {
    mount({ chosen: ['investigate'], defaultSkills: ['graph-tool'] });
    const chip = screen.getByRole('button', { name: 'Remove investigate' });
    expect(within(chip).queryByText('default')).toBeNull();
  });

  it('says in the tooltip that removing it is a decision about this run only', () => {
    mount({ chosen: ['graph-tool'], defaultSkills: ['graph-tool'] });
    const chip = screen.getByRole('button', { name: 'Remove graph-tool' });
    expect(chip.getAttribute('title')).toMatch(/on by default for every run/i);
    expect(chip.getAttribute('title')).toMatch(/this one/i);
  });

  it('shows no badges at all on a console with no defaults set', () => {
    // Which is most of them. The badge must be evidence of a configuration,
    // never decoration that appears regardless.
    mount({ chosen: ['graph-tool'] });
    expect(screen.queryByText('default')).toBeNull();
  });

  it('still lets a default be removed — it is a suggestion, not a fixture', () => {
    // Unlike the plan's own skills, which are rendered as plain chips because
    // they are the plan's statement and not this control's to change.
    const onChange = vi.fn();
    mount({ chosen: ['graph-tool'], defaultSkills: ['graph-tool'], onChange });
    screen.getByRole('button', { name: 'Remove graph-tool' }).click();
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
