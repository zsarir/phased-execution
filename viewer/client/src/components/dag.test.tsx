/**
 * The route map's maths.
 *
 * The layout numbers are the port's whole risk surface: they were derived
 * against a real phone and a real plan, and a rewrite that quietly rounds one of
 * them produces a map that still *looks* fine on a laptop and cannot be tapped
 * on a phone. So the derivation is asserted, not just the value — if someone
 * lowers `MIN_K` to fit more of a big plan on screen, this test explains what
 * they broke before they find out with a thumb.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAP_CONSTANTS, RouteMap, positions, trackPath, wrapLabel } from './dag';
import { getPrefs, setPrefs } from '@/lib/prefs';
import type { RouteView, SessionPlanView } from '@/lib/api';

const { COL_W, ROW_H, PAD, R, TAP, MIN_K, MAX_K, FIT_MAX_K } = MAP_CONSTANTS;

/** A diamond: 1 → {2,3} → 4. Two layers of one, one layer of two. */
const ROUTE: RouteView = {
  nodes: [
    { phase: 1, layer: 0, row: 0, state: 'done', size: 'M', gated: false, title: 'Foundations' },
    { phase: 2, layer: 1, row: 0, state: 'ready', size: 'L', gated: false, title: 'Design system and shell' },
    { phase: 3, layer: 1, row: 1, state: 'waiting', size: 'S', gated: true, title: 'Terminal' },
    { phase: 4, layer: 2, row: 0, state: 'stuck', size: 'M', gated: false, title: 'Cutover' },
  ],
  edges: [{ from: 1, to: 2 }, { from: 1, to: 3 }, { from: 2, to: 4 }, { from: 3, to: 4 }],
  layers: 3,
  rows: 2,
};

describe('the zoom floor', () => {
  it('keeps a 44px target from overlapping the row above it', () => {
    // A station's hit circle is TAP CSS px across at any zoom, and rows are
    // ROW_H plan units apart. The targets stop colliding once TAP/k < ROW_H.
    const collisionFloor = TAP / ROW_H;
    expect(collisionFloor).toBeCloseTo(0.407, 3);
    expect(MIN_K).toBeGreaterThan(collisionFloor);
  });

  it('orders the three zoom bounds the way the toolbar assumes', () => {
    expect(MIN_K).toBeLessThan(FIT_MAX_K);
    expect(FIT_MAX_K).toBeLessThan(MAX_K);
  });

  it('caps the hit radius at the row pitch, so a target never covers its neighbour', () => {
    // The component's rule, restated: at any zoom at or below the floor the cap
    // is what is doing the work, and the cap is smaller than the row pitch.
    const hitR = (k: number) => Math.min(TAP / k, ROW_H - 6) / 2;
    expect(hitR(MIN_K) * 2).toBeLessThan(ROW_H);
    expect(hitR(1) * 2).toBe(TAP);
    expect(hitR(2)).toBeLessThan(hitR(1));
  });
});

describe('positions', () => {
  it('puts a layer in a column and a row in a row', () => {
    const { points } = positions(ROUTE);
    expect(points.get(1)).toMatchObject({ x: PAD, y: PAD + 0.5 * ROW_H });
    expect(points.get(2)).toMatchObject({ x: PAD + COL_W, y: PAD });
    expect(points.get(3)).toMatchObject({ x: PAD + COL_W, y: PAD + ROW_H });
    expect(points.get(4)).toMatchObject({ x: PAD + 2 * COL_W, y: PAD + 0.5 * ROW_H });
  });

  it('centres a short layer against the tallest one', () => {
    // Layer 0 holds one node against a tallest layer of two, so it sits half a
    // row down — a single station level with the gap, not with the top row.
    const { points } = positions(ROUTE);
    expect(points.get(1)!.y).toBe(points.get(2)!.y + ROW_H / 2);
  });

  it('leaves room past the last column for half a label', () => {
    const { width, height } = positions(ROUTE);
    expect(width).toBe(PAD * 2 + (ROUTE.layers - 1) * COL_W + 60);
    expect(height).toBe(PAD * 2 + ROW_H);
  });

  it('does not divide by zero on a one-phase plan', () => {
    const { width, height, points } = positions({
      nodes: [{ phase: 1, layer: 0, row: 0, state: 'ready', size: 'S', gated: false, title: 'Only' }],
      edges: [], layers: 1, rows: 1,
    });
    expect(points.size).toBe(1);
    expect(width).toBe(PAD * 2 + 60);
    expect(height).toBe(PAD * 2);
  });
});

describe('trackPath', () => {
  const at = (x: number, y: number) => ({
    phase: 0, layer: 0, row: 0, state: 'done', size: 'M', gated: false, title: 't', x, y,
  });

  it('draws a straight line between stations on the same row', () => {
    const d = trackPath(at(100, 50), at(300, 50));
    expect(d).toBe(`M${100 + R + 4},50 L${300 - R - 8},50`);
    expect(d).not.toContain('Q');
  });

  it('turns with two rounded corners when the rows differ', () => {
    const d = trackPath(at(100, 50), at(300, 158));
    expect(d.match(/Q/g)).toHaveLength(2);
    expect(d.startsWith(`M${100 + R + 4},50`)).toBe(true);
    expect(d.endsWith(`,158`)).toBe(true);
  });

  it('curves the same way going up as going down', () => {
    const down = trackPath(at(100, 50), at(300, 158));
    const up = trackPath(at(100, 158), at(300, 50));
    expect(down.match(/Q/g)).toHaveLength(up.match(/Q/g)!.length);
  });
});

describe('wrapLabel', () => {
  it('keeps a short title on one line', () => {
    expect(wrapLabel('Cutover')).toEqual(['Cutover']);
  });

  it('breaks a long title onto a second line', () => {
    // The break happens on the word that would take the line *past* 17, so a
    // line of exactly 17 stays whole.
    expect(wrapLabel('Design system and shell')).toEqual(['Design system and', 'shell']);
    expect('Design system and'.length).toBe(17);
  });

  it('elides rather than running a third line off the map', () => {
    const lines = wrapLabel('Plan surface tabs and the dependency map and phase detail');
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(lines[1].length).toBeLessThanOrEqual(17);
  });
});

describe('<RouteMap>', () => {
  const BATCHES: SessionPlanView = {
    groups: [{ index: 1, kind: 'batch', weight: '130K', phases: [2, 3], gated: false }],
    raw: '', budget: '200K/session', excluded: [1],
  };

  it('draws one focusable station per phase, each naming its state out loud', () => {
    render(<RouteMap route={ROUTE} batches={BATCHES} budget={200_000} />);
    // Named, not just counted — the toolbar's zoom controls are buttons too.
    const stations = screen.getAllByRole('button', { name: /^Phase \d/ });
    expect(stations).toHaveLength(4);
    expect(screen.getByLabelText(/Phase 1: Foundations, Departed/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phase 2: .*, Boarding/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phase 3: Terminal, Held/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phase 4: Cutover, Blocked/)).toBeInTheDocument();
    for (const station of stations) expect(station).toHaveAttribute('tabindex', '0');
  });

  it('paints each station with its own state class, so no two states look alike', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(container.querySelector('.station.state-done')).not.toBeNull();
    expect(container.querySelector('.station.state-ready.boarding')).not.toBeNull();
    expect(container.querySelector('.station.state-waiting')).not.toBeNull();
    // `stuck` had aliased `blocked` in the old palette; it is its own line now.
    expect(container.querySelector('.station.state-stuck')).not.toBeNull();
  });

  it('hatches a gated station and nothing else', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(container.querySelectorAll('.gate-ring')).toHaveLength(1);
  });

  it('threads a train through its stations rather than boxing them', () => {
    const { container } = render(<RouteMap route={ROUTE} batches={BATCHES} budget={200_000} />);
    // One line, one ring per carried station — and no rect around the group.
    expect(container.querySelectorAll('.train-line')).toHaveLength(1);
    expect(container.querySelectorAll('.train-ring')).toHaveLength(2);
    expect(container.querySelector('.train rect')).toBeNull();
    expect(container.querySelector('.band-label')?.textContent).toContain('130K/200K');
  });

  it('draws a track per edge and marks the ones already departed', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(container.querySelectorAll('path.track')).toHaveLength(4);
    // Only the two edges leaving phase 1 (done) are drawn as completed track.
    expect(container.querySelectorAll('path.track.track-done')).toHaveLength(2);
  });

  it('renders every station under one viewBox rather than scaling the SVG', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const svg = container.querySelector('svg.route-svg')!;
    expect(svg.getAttribute('viewBox')).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/);
    expect(svg.getAttribute('width')).toBe('100%');
  });
});

describe('the pan & zoom lock', () => {
  beforeEach(() => {
    // Prefs persist in jsdom's localStorage across tests in this file; every
    // case below states its own opening position.
    setPrefs({ mapPanZoom: false });
  });

  const frameOf = (container: HTMLElement) => container.querySelector('.route-frame')! as HTMLElement;
  const viewBoxOf = (container: HTMLElement) =>
    container.querySelector('svg.route-svg')!.getAttribute('viewBox');

  it('opens locked: no interactive marker, and the toggle says so', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    expect(frameOf(container).hasAttribute('data-interactive')).toBe(false);
    const toggle = screen.getByRole('button', { name: 'Pan and zoom' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('a locked map ignores the drag — the viewBox does not move', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    const frame = frameOf(container);
    const before = viewBoxOf(container);
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 160, clientY: 160 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    expect(viewBoxOf(container)).toBe(before);
  });

  it('unlocking turns the same drag into a pan, and remembers the choice', () => {
    const { container } = render(<RouteMap route={ROUTE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pan and zoom' }));
    expect(getPrefs().mapPanZoom).toBe(true);
    const frame = frameOf(container);
    expect(frame.hasAttribute('data-interactive')).toBe(true);
    const before = viewBoxOf(container);
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 160, clientY: 160 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    expect(viewBoxOf(container)).not.toBe(before);
  });

  it('the toolbar zoom buttons work while locked — locking hides nothing', () => {
    render(<RouteMap route={ROUTE} />);
    const readout = () => screen.getByText(/%$/).textContent;
    const before = readout();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(readout()).not.toBe(before);
  });

  it('stations stay tappable while locked', () => {
    const picked: number[] = [];
    render(<RouteMap route={ROUTE} onSelect={(phase) => picked.push(phase)} />);
    fireEvent.click(screen.getByLabelText(/Phase 4: Cutover/));
    expect(picked).toEqual([4]);
  });
});
