/**
 * The route map — the plan as a transit network.
 *
 * Phases are stations, dependencies are track, and each session batch the
 * engine suggests is drawn as a train band around the stations it carries.
 * Columns come from the server's longest-path layering, rows from its
 * barycentre ordering, so the same plan always draws the same way.
 */

import { html, useState, useRef, useEffect, useMemo, useCallback } from '../html.js';
import { STATE_BOARD, weight } from './ui.js';

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

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * The frame's size in CSS pixels, kept current.
 *
 * The map is drawn in plan coordinates and the `viewBox` is the window onto
 * them, so the window has to know how big it is — including after a rotation,
 * which is the one resize a phone actually performs.
 */
function useFrameSize(ref) {
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

const STATE_COLOR = {
  done: 'var(--line-done)',
  ready: 'var(--line-ready)',
  'in-progress': 'var(--line-progress)',
  waiting: 'var(--line-waiting)',
  stuck: 'var(--line-blocked)',
};

function positions(route) {
  const byLayer = new Map();
  for (const node of route.nodes) {
    if (!byLayer.has(node.layer)) byLayer.set(node.layer, []);
    byLayer.get(node.layer).push(node);
  }
  const maxRows = Math.max(1, ...[...byLayer.values()].map((list) => list.length));

  const points = new Map();
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
function trackPath(from, to) {
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

function StationLabel({ node }) {
  const words = node.title.split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const line = lines.at(-1);
    if ((line + ' ' + word).trim().length > 17 && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = (line ? `${line} ` : '') + word;
  }
  if (lines.length === 2 && lines[1].length > 17) lines[1] = `${lines[1].slice(0, 16)}…`;

  return html`
    <text class="station-label" x=${node.x} y=${node.y + R + 16} text-anchor="middle">
      ${lines.map((line, i) => html`<tspan key=${i} x=${node.x} dy=${i === 0 ? 0 : 12}>${line}</tspan>`)}
    </text>`;
}

export function RouteMap({ route, batches, budget, onSelect, selected }) {
  const { points, width, height } = useMemo(() => positions(route), [route]);
  const contentH = height + LABEL_DROP;

  /**
   * `view` is the window onto the plan, in plan coordinates: `x`/`y` are the
   * point at the frame's top-left corner and `k` is plan units per CSS pixel.
   *
   * It used to be a `scale()` transform on a `<g>` inside an SVG with no
   * `viewBox` at all — so the drawing's coordinate system was "whatever pixel
   * size the element happened to have", the SVG grew taller as you zoomed in,
   * and "fit" was a guess at a scale rather than a statement about a rectangle.
   * A viewBox says the thing directly: this is the part of the map you can see.
   */
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState(null);
  const frame = useRef(null);
  const size = useFrameSize(frame);

  // Live pointers by id — two of them is a pinch, one is a drag.
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  // A drag that passes over a station must not also count as choosing it.
  const dragged = useRef(false);

  const fitTo = useCallback((w, h) => ({
    k: clamp(Math.min(w / Math.max(width, 1), h / Math.max(contentH, 1)), MIN_K, FIT_MAX_K),
    w,
    h,
  }), [width, contentH]);

  const centred = useCallback((k, w, h) => ({
    k,
    x: (width - w / k) / 2,
    y: (contentH - h / k) / 2,
  }), [width, contentH]);

  /* Fit once per plan — and once the frame has actually been measured, which
     on a first paint is a tick later. A later resize deliberately does NOT
     refit: rotating the phone should not throw away where you had panned to. */
  const fitted = useRef(null);
  useEffect(() => {
    if (!size.w || !size.h) return;
    const key = `${route.nodes.length}:${width}:${height}`;
    if (fitted.current === key) return;
    fitted.current = key;
    const { k } = fitTo(size.w, size.h);
    setView(centred(k, size.w, size.h));
  }, [route, width, height, size.w, size.h, fitTo, centred]);

  /** Zoom about a point in the frame, so what is under the finger stays there. */
  const zoomAt = useCallback((px, py, next) => {
    setView((v) => {
      const k = clamp(next(v.k), MIN_K, MAX_K);
      if (k === v.k) return v;
      return { k, x: v.x + px / v.k - px / k, y: v.y + py / v.k - py / k };
    });
  }, []);

  const local = (clientX, clientY) => {
    const rect = frame.current?.getBoundingClientRect();
    return rect ? { px: clientX - rect.left, py: clientY - rect.top } : { px: 0, py: 0 };
  };

  const highlight = hover ?? selected ?? null;
  const related = useMemo(() => {
    if (highlight == null) return null;
    const set = new Set([highlight]);
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
  const trains = useMemo(() => (batches?.groups ?? []).map((group) => {
    const nodes = group.phases.map((phase) => points.get(phase)).filter(Boolean);
    if (!nodes.length) return null;
    const ordered = [...nodes].sort((a, b) => a.layer - b.layer || a.row - b.row);
    return {
      ...group,
      nodes: ordered,
      path: ordered.map((node, i) => `${i === 0 ? 'M' : 'L'}${node.x},${node.y}`).join(' '),
      head: ordered[0],
    };
  }).filter(Boolean), [batches, points]);

  const onWheel = (event) => {
    event.preventDefault();
    const { px, py } = local(event.clientX, event.clientY);
    const factor = event.deltaY > 0 ? 0.92 : 1.08;
    zoomAt(px, py, (k) => k * factor);
  };

  const startDrag = (clientX, clientY) => { gesture.current = { kind: 'drag', x: clientX, y: clientY }; };

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged.current = false;
    // Capture keeps a drag alive past the edge of the frame. It throws rather
    // than no-ops when the id is not an active pointer, and an exception here
    // would take the rest of the gesture with it.
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* not capturable */ }

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view.k };
    } else if (pointers.current.size === 1) {
      startDrag(event.clientX, event.clientY);
    }
  };

  const onPointerMove = (event) => {
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

  const onPointerUp = (event) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) { gesture.current = null; return; }
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

  const zoomCentre = (factor) => zoomAt((size.w || 0) / 2, (size.h || 0) / 2, (k) => k * factor);

  /* The window, in plan units. Falls back to the content box until the frame
     has been measured, so the first paint draws the whole map rather than a
     division by zero. */
  const boxW = (size.w || width * view.k) / view.k;
  const boxH = (size.h || contentH * view.k) / view.k;

  /* A station's hit area, in plan units, so it lands at 44 CSS px whatever the
     zoom. Capped at the row pitch: a target that overlaps its neighbour is
     worse than a small one, and below MIN_K the cap would be doing that. */
  const hitR = Math.min(TAP / view.k, ROW_H - 6) / 2;

  return html`
    <div class="route">
      <div class="route-toolbar">
        <div class="row-wrap">
          ${['done', 'ready', 'in-progress', 'waiting', 'stuck'].map((state) => html`
            <span class=${`legend state-${state}`} key=${state}>
              <span class="legend-dot"></span>${STATE_BOARD[state]}
            </span>`)}
          <span class="legend state-gated"><span class="legend-dot hatched"></span>Gated</span>
        </div>
        <div class="row">
          <span class="faint mono">${Math.round(view.k * 100)}%</span>
          <div class="btn-group">
            <button class="btn small" onClick=${() => zoomCentre(0.9)} aria-label="Zoom out">−</button>
            <button class="btn small" onClick=${() => zoomCentre(1.1)} aria-label="Zoom in">+</button>
            <button class="btn small" onClick=${fit}>Fit</button>
          </div>
        </div>
      </div>

      <div
        class="route-frame"
        ref=${frame}
        onWheel=${onWheel}
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerUp}
        onPointerCancel=${onPointerUp}>
        <svg
          class="route-svg"
          width="100%"
          height="100%"
          viewBox=${`${view.x} ${view.y} ${boxW} ${boxH}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Phase dependency map">
          <defs>
            <pattern id="gate-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-gated)" stroke-width="3" opacity="0.5" />
            </pattern>
          </defs>

          <g>
            ${trains.map((train) => html`
              <g class="train" key=${`train-${train.index}`}>
                ${train.nodes.length > 1 ? html`<path class="train-line" d=${train.path} />` : null}
                ${train.nodes.map((node) => html`
                  <circle key=${node.phase} class="train-ring" cx=${node.x} cy=${node.y} r=${R + 7} />`)}
                <text x=${train.head.x} y=${train.head.y - R - 14} class="band-label" text-anchor="middle">
                  S${train.index} · ${train.weight ?? ''}${budget ? `/${weight(budget)}` : ''}${train.gated ? ' · gated' : ''}
                </text>
              </g>`)}

            ${route.edges.map((edge) => {
              const from = points.get(edge.from);
              const to = points.get(edge.to);
              if (!from || !to) return null;
              const dim = related && !(related.has(edge.from) && related.has(edge.to));
              return html`
                <path
                  key=${`${edge.from}-${edge.to}`}
                  class=${`track ${from.state === 'done' ? 'track-done' : ''} ${dim ? 'dim' : ''}`}
                  style=${`--i:${from.layer}`}
                  d=${trackPath(from, to)} />`;
            })}

            ${/* Each station carries an invisible `station-hit` circle sized in
                  plan units to land at 44 CSS px. The 15-unit dot it sits under
                  is a 13px circle at the fit zoom of a phone — a mark, not a
                  target. Transparent rather than `fill: none`, because `none`
                  does not receive pointer events at all. */
              [...points.values()].map((node) => {
              const dim = related && !related.has(node.phase);
              return html`
                <g
                  key=${node.phase}
                  class=${`station state-${node.state} ${node.state === 'ready' ? 'boarding' : ''} ${dim ? 'dim' : ''} ${selected === node.phase ? 'selected' : ''}`}
                  transform=${`translate(0,0)`}
                  tabindex="0"
                  role="button"
                  aria-label=${`Phase ${node.phase}: ${node.title}, ${STATE_BOARD[node.state] ?? node.state}`}
                  onClick=${() => { if (!dragged.current) onSelect?.(node.phase); }}
                  onKeyDown=${(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(node.phase); } }}
                  onMouseEnter=${() => setHover(node.phase)}
                  onMouseLeave=${() => setHover(null)}>
                  <circle class="station-hit" cx=${node.x} cy=${node.y} r=${hitR} />
                  ${node.gated ? html`<circle class="gate-ring" cx=${node.x} cy=${node.y} r=${R + 6} fill="url(#gate-hatch)" />` : null}
                  <circle class="halo" cx=${node.x} cy=${node.y} r=${R + 5} />
                  <circle class="dot" cx=${node.x} cy=${node.y} r=${R} />
                  <text class="station-number" x=${node.x} y=${node.y + 4} text-anchor="middle">${node.phase}</text>
                  <${StationLabel} node=${node} />
                  <title>${`Phase ${node.phase} — ${node.title} · ${STATE_BOARD[node.state] ?? node.state} · size ${node.size}`}</title>
                </g>`;
            })}
          </g>
        </svg>
      </div>
    </div>`;
}

export { STATE_COLOR };
