/**
 * Button, Card, Tabs, Table, Accordion — the structural surfaces. What
 * these tests hold: a Button defaults to `type="button"` (a form cannot
 * submit by accident) and `asChild` lends the classes to a real link; amber
 * (`action`) is a variant a caller must ask for; a Tile is a number made a
 * fact by its label, painted by a state token; Tabs are Radix's — real
 * `tablist`/`tab` roles with arrow-key roving focus; a Table lives inside
 * the one overflow-x wrapper (the page body must never scroll sideways) and
 * its header is NOT sticky (inside that wrapper sticky is pure paint cost);
 * an Accordion's whole header row is the trigger and `aria-expanded` tells
 * the truth.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion';
import { Button, ButtonGroup } from './button';
import { Card, CardBody, CardHeader, CardTitle, Tile } from './card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from './table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Button', () => {
  it('defaults to type="button" — never an accidental submit', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('variant="action" is the amber one', () => {
    render(<Button variant="action">Start phase</Button>);
    expect(screen.getByRole('button')).toHaveClass('text-action');
    const { container } = render(<Button>Plain</Button>);
    expect(container.querySelector('button')).not.toHaveClass('text-action');
  });

  it('asChild lends the classes to a real element', () => {
    render(
      <Button asChild variant="ghost">
        <a href="/runs">All runs</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'All runs' });
    expect(link.tagName).toBe('A');
    expect(link.className).toContain('inline-flex');
    expect(link).not.toHaveAttribute('type');
  });

  it('ButtonGroup is a group', () => {
    render(
      <ButtonGroup aria-label="Density">
        <Button aria-pressed="true">Cozy</Button>
        <Button aria-pressed="false">Compact</Button>
      </ButtonGroup>,
    );
    expect(screen.getByRole('group', { name: 'Density' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ButtonGroup aria-label="Density">
        <Button aria-pressed="true">Cozy</Button>
        <Button aria-pressed="false">Compact</Button>
      </ButtonGroup>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Card + Tile', () => {
  it('a card is its header, title and body', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Session budget</CardTitle>
        </CardHeader>
        <CardBody>
          <p>310K of 400K</p>
        </CardBody>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Session budget' })).toBeInTheDocument();
    expect(screen.getByText('310K of 400K')).toBeInTheDocument();
  });

  it('a Tile is a number made a fact by its label, painted by its state', () => {
    render(<Tile label="ready" value={3} state="state-queued" hint="next up" />);
    expect(screen.getByText('3')).toHaveClass('text-state');
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('next up')).toBeInTheDocument();
    expect(screen.getByText('3').parentElement).toHaveClass('state-queued');
  });

  it('an unpainted Tile stays ink', () => {
    render(<Tile label="phases" value={11} />);
    expect(screen.getByText('11')).toHaveClass('text-ink');
    expect(screen.getByText('11')).not.toHaveClass('text-state');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Plan</CardTitle>
        </CardHeader>
        <CardBody>
          <Tile label="done" value={6} state="state-done" />
        </CardBody>
      </Card>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Tabs', () => {
  const mount = () =>
    render(
      <Tabs defaultValue="board">
        <TabsList aria-label="Plan views">
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="map">Map</TabsTrigger>
          <TabsTrigger value="journal">Journal</TabsTrigger>
        </TabsList>
        <TabsContent value="board">
          <p>the board</p>
        </TabsContent>
        <TabsContent value="map">
          <p>the map</p>
        </TabsContent>
        <TabsContent value="journal">
          <p>the journal</p>
        </TabsContent>
      </Tabs>,
    );

  it('renders a real tablist with tabs and shows the active panel', () => {
    mount();
    expect(screen.getByRole('tablist', { name: 'Plan views' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('the board')).toBeInTheDocument();
    expect(screen.queryByText('the map')).toBeNull();
  });

  it('arrow keys move focus along the tabs (roving tabindex)', async () => {
    mount();
    const board = screen.getByRole('tab', { name: 'Board' });
    act(() => board.focus());
    fireEvent.keyDown(board, { key: 'ArrowRight' });
    // Radix moves the roving focus on a timeout tick; flush it inside act.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByRole('tab', { name: 'Map' })).toHaveFocus();
  });

  it('picking a tab switches the panel (Radix activates on mousedown)', () => {
    mount();
    const journal = screen.getByRole('tab', { name: 'Journal' });
    fireEvent.mouseDown(journal, { button: 0, ctrlKey: false });
    fireEvent.click(journal);
    expect(screen.getByText('the journal')).toBeInTheDocument();
    expect(screen.queryByText('the board')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});

describe('Table', () => {
  const mount = () =>
    render(
      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Phase</TH>
              <TH>State</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>01</TD>
              <TD>done</TD>
            </TR>
            <TR>
              <TD>02</TD>
              <TD>ready</TD>
            </TR>
          </TBody>
        </Table>
      </TableWrap>,
    );

  it('the wrapper owns the sideways scroll, so the page never does', () => {
    const { container } = mount();
    expect(container.firstElementChild).toHaveClass('overflow-x-auto');
  });

  it('the header is not sticky — inside an overflow-x wrapper it could only lie', () => {
    const { container } = mount();
    const thead = container.querySelector('thead') as HTMLElement;
    expect(thead.className).not.toMatch(/sticky/);
  });

  it('column headers carry scope', () => {
    mount();
    for (const th of screen.getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col');
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});

describe('Accordion', () => {
  const mount = () =>
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="how">
          <AccordionTrigger>How was it tried?</AccordionTrigger>
          <AccordionContent>Twice, by the ladder.</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

  it('the trigger opens its content and aria-expanded flips', () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'How was it tried?' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Twice, by the ladder.')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Twice, by the ladder.')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('the chevron is decoration on the trigger, not a second control', () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'How was it tried?' });
    expect(trigger.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('has no axe violations, closed and open', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole('button', { name: 'How was it tried?' }));
    await expectNoAxeViolations(container);
  });
});
