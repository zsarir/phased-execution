/**
 * The route map — the plan as a transit network.
 *
 * Phases are stations, dependencies are track, and each session batch the
 * engine suggests is drawn as a train threading the stations it carries.
 * Columns come from the server's longest-path layering, rows from its
 * barycentre ordering, so the same plan always draws the same way.
 *
 * ---- What is a port and what is new ----
 *
 * Every number below is `web/components/dag.js` verbatim: the layout constants,
 * the fit/centre maths, the zoom-about-a-point algebra, the drag/pinch state
 * machine, and the `MIN_K` derivation with the reasoning that produced it. They
 * were arrived at against a real phone and a real plan; re-deriving them from
 * taste would lose that.
 *
 * What is new is the shape: the view state and the gestures are a hook
 * (`useMapView`) that knows nothing about stations, and the SVG is a component
 * that knows nothing about pointers. The one behavioural change is forced by
 * React — see `useMapView` on the wheel listener.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lock, Unlock } from 'lucide-react';
import { Button, ButtonGroup, asPhaseState, type PhaseState } from '@/components/ui';
import { STATE_META, boardLabel, boardUiState, type UiState } from '@/lib/status-vocab';
import { weight } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useNarrow } from '@/lib/media';
import { usePrefs } from '@/lib/prefs';
import type { BatchGroup, RouteNode, RouteView, SessionPlanView } from '@/lib/api';

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

const COL_W = 178;
const ROW_H = 108;
const PAD = 58;
const R = 15;

/* Labels hang below the last row of stations; the content box has to include
   them or "fit" cuts the bottom line of every name in the last rank. */
const LABEL_DROP = 40;

/** A finger's worth of station, in CSS pixels. */
const TAP = 44;

/**
 * The zoom floor is a touch decision, not a taste one.
 *
 * Rows are `ROW_H` apart, so a 44px target stops overlapping its neighbour
 * above only once 44/k < ROW_H — that is k > 0.407. The old floor was 0.25,
 * which drew ~10px stations with 4px labels and put three of them inside one
 * thumb. At 0.45 the whole map may not fit a phone at once, which is fine:
 * a map you pan is a map, and a map you cannot hit is a picture.
 */
const MIN_K = 0.45;
const MAX_K = 2.4;
const FIT_MAX_K = 1.6;

/** Exported for the test that re-derives the floor from the two it depends on. */
export const MAP_CONSTANTS = { COL_W, ROW_H, PAD, R, LABEL_DROP, TAP, MIN_K, MAX_K, FIT_MAX_K };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export interface PlacedNode extends RouteNode {
  x: number;
  y: number;
}

export interface Layout {
  points: Map<number, PlacedNode>;
  width: number;
  height: number;
}

/** Layer → column, row → row, both in plan coordinates. */
export function positions(route: RouteView): Layout {
  const byLayer = new Map<number, RouteNode[]>();
  for (const node of route.nodes) {
    if (!byLayer.has(node.layer)) byLayer.set(node.layer, []);
    byLayer.get(node.layer)!.push(node);
  }
  const maxRows = Math.max(1, ...[...byLayer.values()].map((list) => list.length));

  const points = new Map<number, PlacedNode>();
  for (const [layer, list] of byLayer) {
    const offset = (maxRows - list.length) / 2;
    for (const node of list) {
      points.set(node.phase, {
        ...node,
        x: PAD + layer * COL_W,
        y: PAD + (offset + node.row) * ROW_H,
      });
    }
  }
  return {
    points,
    // Labels are centred under their station, so the last column needs room
    // for half a label past the node itself.
    width: PAD * 2 + Math.max(0, route.layers - 1) * COL_W + 60,
    height: PAD * 2 + Math.max(0, maxRows - 1) * ROW_H,
  };
}

/** Orthogonal track with rounded corners, drawn from one station to the next. */
export function trackPath(from: PlacedNode, to: PlacedNode): string {
  const x1 = from.x + R + 4;
  const x2 = to.x - R - 8;
  if (Math.abs(from.y - to.y) < 1) return `M${x1},${from.y} L${x2},${to.y}`;

  const mid = x1 + Math.max(22, (x2 - x1) / 2);
  const down = to.y > from.y ? 1 : -1;
  const curve = Math.min(14, Math.abs(to.y - from.y) / 2);
  return [
    `M${x1},${from.y}`,
    `L${mid - curve},${from.y}`,
    `Q${mid},${from.y} ${mid},${from.y + curve * down}`,
    `L${mid},${to.y - curve * down}`,
    `Q${mid},${to.y} ${mid + curve},${to.y}`,
    `L${x2},${to.y}`,
  ].join(' ');
}

/* ------------------------------------------------------------------ *
 * The window onto the map
 * ------------------------------------------------------------------ */

/**
 * The frame's size in CSS pixels, kept current.
 *
 * The map is drawn in plan coordinates and the `viewBox` is the window onto
 * them, so the window has to know how big it is — including after a rotation,
 * which is the one resize a phone actually performs.
 */
function useFrameSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => setSize({ w: node.clientWidth, h: node.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export interface MapView {
  /** Plan units per CSS pixel. */
  k: number;
  /** The plan point at the frame's top-left corner. */
  x: number;
  y: number;
}

/**
 * Pan, pinch and zoom over a fixed frame.
 *
 * `view` is the window onto the plan, in plan coordinates. It used to be a
 * `scale()` transform on a `<g>` inside an SVG with no `viewBox` at all — so the
 * drawing's coordinate system was "whatever pixel size the element happened to
 * have", the SVG grew taller as you zoomed in, and "fit" was a guess at a scale
 * rather than a statement about a rectangle. A viewBox says the thing directly:
 * this is the part of the map you can see.
 */
export function useMapView({
  width,
  contentH,
  fitKey,
  interactive = true,
}: {
  width: number;
  contentH: number;
  /** Changes when the drawing changes — a new plan refits, a resize does not. */
  fitKey: string;
  /**
   * Whether the wheel, drag and pinch gestures are live. Off means the map is
   * a picture the page scrolls past — the wheel listener is simply never
   * attached and pointers are ignored — while `fit`, `zoomCentre` and the
   * initial auto-fit keep working, so the toolbar buttons always do.
   */
  interactive?: boolean;
}) {
  const [view, setView] = useState<MapView>({ k: 1, x: 0, y: 0 });
  const frame = useRef<HTMLDivElement>(null);
  const size = useFrameSize(frame);

  // Live pointers by id — two of them is a pinch, one is a drag.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    { kind: 'drag'; x: number; y: number } | { kind: 'pinch'; dist: number; k: number } | null
  >(null);
  // A drag that passes over a station must not also count as choosing it.
  const dragged = useRef(false);

  const fitTo = useCallback(
    (w: number, h: number) => ({
      k: clamp(Math.min(w / Math.max(width, 1), h / Math.max(contentH, 1)), MIN_K, FIT_MAX_K),
      w,
      h,
    }),
    [width, contentH],
  );

  const centred = useCallback(
    (k: number, w: number, h: number): MapView => ({
      k,
      x: (width - w / k) / 2,
      y: (contentH - h / k) / 2,
    }),
    [width, contentH],
  );

  /* Fit once per plan — and once the frame has actually been measured, which
     on a first paint is a tick later. A later resize deliberately does NOT
     refit: rotating the phone should not throw away where you had panned to. */
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!size.w || !size.h) return;
    if (fitted.current === fitKey) return;
    fitted.current = fitKey;
    const { k } = fitTo(size.w, size.h);
    setView(centred(k, size.w, size.h));
  }, [fitKey, size.w, size.h, fitTo, centred]);

  /** Zoom about a point in the frame, so what is under the finger stays there. */
  const zoomAt = useCallback((px: number, py: number, next: (k: number) => number) => {
    setView((v) => {
      const k = clamp(next(v.k), MIN_K, MAX_K);
      if (k === v.k) return v;
      return { k, x: v.x + px / v.k - px / k, y: v.y + py / v.k - py / k };
    });
  }, []);

  const local = useCallback((clientX: number, clientY: number) => {
    const rect = frame.current?.getBoundingClientRect();
    return rect ? { px: clientX - rect.left, py: clientY - rect.top } : { px: 0, py: 0 };
  }, []);

  /**
   * The wheel listener is native, not a React prop — and that is the one place
   * this port could not be verbatim.
   *
   * React registers `wheel` on its root container as **passive**, so a
   * `preventDefault()` inside `onWheel` does nothing but log a warning, and the
   * page scrolls away underneath a map you were trying to zoom. The old client
   * used Preact, which binds handlers to the element itself and is therefore
   * non-passive by default. `{ passive: false }` here restores the old
   * behaviour exactly.
   */
  useEffect(() => {
    const node = frame.current;
    // Locked: no listener at all — a `preventDefault` that never runs is what
    // lets the page scroll natively over the map.
    if (!node || !interactive) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { px, py } = local(event.clientX, event.clientY);
      const factor = event.deltaY > 0 ? 0.92 : 1.08;
      zoomAt(px, py, (k) => k * factor);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [local, zoomAt, interactive]);

  // A toggle mid-gesture must not strand a half-finished drag or pinch: the
  // next unlock would resume a gesture whose fingers left long ago.
  useEffect(() => {
    if (interactive) return;
    pointers.current.clear();
    gesture.current = null;
    dragged.current = false;
  }, [interactive]);

  const startDrag = (clientX: number, clientY: number) => {
    gesture.current = { kind: 'drag', x: clientX, y: clientY };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged.current = false;
    // Capture keeps a drag alive past the edge of the frame. It throws rather
    // than no-ops when the id is not an active pointer, and an exception here
    // would take the rest of the gesture with it.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* not capturable */
    }

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view.k };
    } else if (pointers.current.size === 1) {
      startDrag(event.clientX, event.clientY);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = gesture.current;
    if (!active) return;

    if (active.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      const { px, py } = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      dragged.current = true;
      zoomAt(px, py, () => active.k * (spread / active.dist));
      return;
    }

    if (active.kind === 'drag') {
      const dx = event.clientX - active.x;
      const dy = event.clientY - active.y;
      active.x = event.clientX;
      active.y = event.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged.current = true;
      setView((v) => ({ ...v, x: v.x - dx / v.k, y: v.y - dy / v.k }));
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      return;
    }
    // A pinch that loses one finger becomes a drag with the one left, rather
    // than a dead gesture you have to lift and start again.
    const [rest] = [...pointers.current.values()];
    startDrag(rest.x, rest.y);
  };

  const fit = () => {
    if (!size.w || !size.h) return;
    const { k } = fitTo(size.w, size.h);
    setView(centred(k, size.w, size.h));
  };

  const zoomCentre = (factor: number) => zoomAt((size.w || 0) / 2, (size.h || 0) / 2, (k) => k * factor);

  /**
   * Put a plan point in the middle of the frame, at whatever zoom is current.
   *
   * Pan only, never zoom: the caller is saying "look here", not "look closer",
   * and a map that also re-scaled itself would throw away a zoom the operator
   * chose. Stable across renders so an effect can depend on it.
   */
  const centreOn = useCallback(
    (x: number, y: number) => {
      setView((v) => (size.w && size.h ? { ...v, x: x - size.w / v.k / 2, y: y - size.h / v.k / 2 } : v));
    },
    [size.w, size.h],
  );

  return {
    frame,
    view,
    size,
    fit,
    zoomCentre,
    centreOn,
    /** Read at click time: a drag that crossed a station is not a tap on it. */
    dragged,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

function StationLabel({ node }: { node: PlacedNode }) {
  const lines = useMemo(() => wrapLabel(node.title), [node.title]);
  return (
    <text className="station-label" x={node.x} y={node.y + R + 16} textAnchor="middle">
      {lines.map((line, i) => (
        <tspan key={i} x={node.x} dy={i === 0 ? 0 : 12}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/** Two lines of at most ~17 characters, the second elided. Ported verbatim. */
export function wrapLabel(title: string): string[] {
  const words = title.split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const line = lines.at(-1)!;
    if ((line + ' ' + word).trim().length > 17 && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = (line ? `${line} ` : '') + word;
  }
  if (lines.length === 2 && lines[1].length > 17) lines[1] = `${lines[1].slice(0, 16)}…`;
  return lines;
}

interface Train extends BatchGroup {
  nodes: PlacedNode[];
  path: string;
  head: PlacedNode;
}

/**
 * The legend: the UI states a station can be in, worst first — plus the
 * hatched disc for a gate, which is a needs-you with a barrier drawn on it.
 * Labels come from the vocabulary; `ready` reads "Next up" like every badge.
 */
const LEGEND: readonly { state: UiState; label: string }[] = [
  { state: 'needs-you', label: STATE_META['needs-you'].label },
  { state: 'running', label: STATE_META.running.label },
  { state: 'queued', label: boardLabel('ready') },
  { state: 'waiting', label: STATE_META.waiting.label },
  { state: 'done', label: STATE_META.done.label },
];

export interface RouteMapProps {
  route: RouteView;
  batches?: SessionPlanView | null;
  /** The plan's per-session budget, in tokens — printed beside each train. */
  budget?: number;
  onSelect?: (phase: number) => void;
  selected?: number | null;
  /**
   * The station the map opens looking at.
   *
   * A plan of forty phases fits the frame by being drawn small, and the one
   * node that wanted a person was as likely to be in a corner as anywhere. The
   * caller decides WHICH — this only knows how to look at it — and it is
   * honoured once per plan, so panning away is not undone on the next render.
   */
  focus?: number | null;
  className?: string;
}

/**
 * Everything a station can say without being clicked.
 *
 * The map is the one surface where a phase has no room for columns, so its
 * `<title>` is where the same facts the tables now carry — what it waits on,
 * whether anyone holds it — have to live instead.
 */
function stationTitle(
  node: { phase: number; title: string; size: string; locked?: 'live' | 'stale' },
  state: PhaseState,
  needs: number[] | undefined,
): string {
  const lines = [`Phase ${node.phase} — ${node.title}`, `${boardLabel(state)} · size ${node.size}`];
  if (needs?.length) lines.push(`needs ${needs.map((n) => `P${n}`).join(' · ')}`);
  if (node.locked === 'live') lines.push('claimed by another session');
  if (node.locked === 'stale') lines.push('a lapsed claim — release it to tidy the board');
  return lines.join('\n');
}

export function RouteMap({ route, batches, budget, onSelect, selected, focus, className }: RouteMapProps) {
  const { points, width, height } = useMemo(() => positions(route), [route]);
  const contentH = height + LABEL_DROP;

  const [hover, setHover] = useState<number | null>(null);
  const [prefs, setPrefs] = usePrefs();
  const narrow = useNarrow();
  const fitKey = `${route.nodes.length}:${width}:${height}`;
  const { frame, view, size, fit, zoomCentre, centreOn, dragged, handlers } = useMapView({
    width,
    contentH,
    fitKey,
    interactive: prefs.mapPanZoom,
  });

  /* Look at the station the caller named — once per plan, after the fit has
     landed. Once per plan and not once per render, because the point of the
     gesture is where you go NEXT, and a map that snapped back to the same node
     every time the run stream ticked could not be panned at all. */
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (focus == null || !size.w || !size.h) return;
    const key = `${fitKey}:${focus}`;
    if (focused.current === key) return;
    const point = points.get(focus);
    if (!point) return;
    focused.current = key;
    centreOn(point.x, point.y);
  }, [focus, fitKey, points, size.w, size.h, centreOn]);

  /** What each station waits on — the edges, read the way a tooltip needs them. */
  const incoming = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const edge of route.edges) {
      const list = map.get(edge.to);
      if (list) list.push(edge.from);
      else map.set(edge.to, [edge.from]);
    }
    return map;
  }, [route]);

  const highlight = hover ?? selected ?? null;
  const related = useMemo(() => {
    if (highlight == null) return null;
    const set = new Set<number>([highlight]);
    for (const edge of route.edges) {
      if (edge.to === highlight) set.add(edge.from);
      if (edge.from === highlight) set.add(edge.to);
    }
    return set;
  }, [highlight, route]);

  /**
   * A train is drawn as a dashed line threading the stations it carries, not
   * as a box around them — a bounding box would enclose bystanders that are
   * not in the batch at all, which is exactly the wrong thing to imply.
   */
  const trains = useMemo<Train[]>(
    () =>
      (batches?.groups ?? [])
        .map((group) => {
          const nodes = group.phases
            .map((phase) => points.get(phase))
            .filter((n): n is PlacedNode => Boolean(n));
          if (!nodes.length) return null;
          const ordered = [...nodes].sort((a, b) => a.layer - b.layer || a.row - b.row);
          return {
            ...group,
            nodes: ordered,
            path: ordered.map((node, i) => `${i === 0 ? 'M' : 'L'}${node.x},${node.y}`).join(' '),
            head: ordered[0],
          };
        })
        .filter((t): t is Train => Boolean(t)),
    [batches, points],
  );

  /* The window, in plan units. Falls back to the content box until the frame
     has been measured, so the first paint draws the whole map rather than a
     division by zero. */
  const boxW = (size.w || width * view.k) / view.k;
  const boxH = (size.h || contentH * view.k) / view.k;

  /* A station's hit area, in plan units, so it lands at 44 CSS px whatever the
     zoom. Capped at the row pitch: a target that overlaps its neighbour is
     worse than a small one, and below MIN_K the cap would be doing that. */
  const hitR = Math.min(TAP / view.k, ROW_H - 6) / 2;

  return (
    <div className={cn('overflow-hidden rounded-lg border border-rule bg-surface', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-surface-raised px-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          {LEGEND.map(({ state, label }) => (
            <span
              key={state}
              className={cn(
                'inline-flex items-center gap-1.5 font-display text-2xs uppercase tracking-wider text-ink-faint',
                `state-${state}`,
              )}
            >
              <span className="legend-dot" aria-hidden />
              {label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 font-display text-2xs uppercase tracking-wider text-ink-faint state-needs-you">
            <span className="legend-dot hatched" aria-hidden />
            Gated
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            aria-pressed={prefs.mapPanZoom}
            aria-label="Pan and zoom"
            title={
              prefs.mapPanZoom
                ? 'Lock the map — the page scrolls over it again.'
                : 'Unlock to pan, drag and pinch the map. The − / + / Fit buttons always work.'
            }
            onClick={() => setPrefs({ mapPanZoom: !prefs.mapPanZoom })}
          >
            {prefs.mapPanZoom ? <Unlock size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
            {!narrow && <span className="ml-1">Pan &amp; zoom</span>}
          </Button>
          <span className="font-mono text-2xs text-ink-faint" aria-live="off">
            {Math.round(view.k * 100)}%
          </span>
          <ButtonGroup>
            <Button size="sm" onClick={() => zoomCentre(0.9)} aria-label="Zoom out">
              −
            </Button>
            <Button size="sm" onClick={() => zoomCentre(1.1)} aria-label="Zoom in">
              +
            </Button>
            <Button size="sm" onClick={fit}>
              Fit
            </Button>
          </ButtonGroup>
        </div>
      </div>

      <div className="route-frame" ref={frame} data-interactive={prefs.mapPanZoom || undefined} {...handlers}>
        <svg
          className="route-svg"
          width="100%"
          height="100%"
          viewBox={`${view.x} ${view.y} ${boxW} ${boxH}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Phase dependency map"
        >
          <defs>
            <pattern
              id="gate-hatch"
              width="6"
              height="6"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-gated)" strokeWidth="3" opacity="0.5" />
            </pattern>
          </defs>

          <g>
            {trains.map((train) => (
              <g className="train" key={`train-${train.index}`}>
                {train.nodes.length > 1 && <path className="train-line" d={train.path} />}
                {train.nodes.map((node) => (
                  <circle key={node.phase} className="train-ring" cx={node.x} cy={node.y} r={R + 7} />
                ))}
                <text x={train.head.x} y={train.head.y - R - 14} className="band-label" textAnchor="middle">
                  S{train.index} · {train.weight ?? ''}
                  {budget ? `/${weight(budget)}` : ''}
                  {train.gated ? ' · gated' : ''}
                </text>
              </g>
            ))}

            {route.edges.map((edge) => {
              const from = points.get(edge.from);
              const to = points.get(edge.to);
              if (!from || !to) return null;
              const dim = related && !(related.has(edge.from) && related.has(edge.to));
              return (
                <path
                  key={`${edge.from}-${edge.to}`}
                  className={cn('track', from.state === 'done' && 'track-done', dim && 'dim')}
                  style={{ '--i': from.layer } as React.CSSProperties}
                  d={trackPath(from, to)}
                />
              );
            })}

            {/* Each station carries an invisible `station-hit` circle sized in
                plan units to land at 44 CSS px. The 15-unit dot it sits under
                is a 13px circle at the fit zoom of a phone — a mark, not a
                target. Transparent rather than `fill: none`, because `none`
                does not receive pointer events at all. */}
            {[...points.values()].map((node) => {
              const dim = related && !related.has(node.phase);
              const state = asPhaseState(node.state);
              return (
                <g
                  key={node.phase}
                  className={cn(
                    'station',
                    // The station wears its UI state; the CSS paints by it.
                    `state-${boardUiState(state)}`,
                    state === 'ready' && 'boarding',
                    dim && 'dim',
                    selected === node.phase && 'selected',
                  )}
                  tabIndex={0}
                  role="button"
                  aria-label={`Phase ${node.phase}: ${node.title}, ${boardLabel(state)}`}
                  onClick={() => {
                    if (!dragged.current) onSelect?.(node.phase);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect?.(node.phase);
                    }
                  }}
                  onMouseEnter={() => setHover(node.phase)}
                  onMouseLeave={() => setHover(null)}
                >
                  <circle className="station-hit" cx={node.x} cy={node.y} r={hitR} />
                  {node.gated && (
                    <circle className="gate-ring" cx={node.x} cy={node.y} r={R + 6} fill="url(#gate-hatch)" />
                  )}
                  {node.locked && (
                    <circle className={cn('claim-ring', node.locked)} cx={node.x} cy={node.y} r={R + 4} />
                  )}
                  <circle className="halo" cx={node.x} cy={node.y} r={R + 5} />
                  <circle className="dot" cx={node.x} cy={node.y} r={R} />
                  <text className="station-number" x={node.x} y={node.y + 4} textAnchor="middle">
                    {node.phase}
                  </text>
                  <StationLabel node={node} />
                  <title>{stationTitle(node, state, incoming.get(node.phase))}</title>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
