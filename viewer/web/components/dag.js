/**
 * The route map — the plan as a transit network.
 *
 * Phases are stations, dependencies are track, and each session batch the
 * engine suggests is drawn as a train band around the stations it carries.
 * Columns come from the server's longest-path layering, rows from its
 * barycentre ordering, so the same plan always draws the same way.
 */

import { html, useState, useRef, useEffect, useMemo } from '../html.js';
import { STATE_BOARD, weight } from './ui.js';

const COL_W = 178;
const ROW_H = 108;
const PAD = 58;
const R = 15;

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
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState(null);
  const frame = useRef(null);
  const drag = useRef(null);

  // Fit once per plan, so a 31-phase graph opens readable.
  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const scale = Math.min(1, (node.clientWidth - 16) / Math.max(width, 1));
    setView({ k: Math.max(0.35, scale), x: 0, y: 0 });
  }, [route, width]);

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
    const factor = event.deltaY > 0 ? 0.92 : 1.08;
    setView((v) => ({ ...v, k: Math.min(2.4, Math.max(0.25, v.k * factor)) }));
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, startX: view.x, startY: view.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    setView((v) => ({
      ...v,
      x: drag.current.startX + (event.clientX - drag.current.x),
      y: drag.current.startY + (event.clientY - drag.current.y),
    }));
  };
  const onPointerUp = () => { drag.current = null; };

  const fit = () => {
    const node = frame.current;
    if (!node) return;
    setView({ k: Math.max(0.3, Math.min(1.6, (node.clientWidth - 16) / Math.max(width, 1))), x: 0, y: 0 });
  };

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
            <button class="btn small" onClick=${() => setView((v) => ({ ...v, k: Math.max(0.25, v.k * 0.9) }))} aria-label="Zoom out">−</button>
            <button class="btn small" onClick=${() => setView((v) => ({ ...v, k: Math.min(2.4, v.k * 1.1) }))} aria-label="Zoom in">+</button>
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
        onPointerLeave=${onPointerUp}>
        <svg
          class="route-svg"
          width="100%"
          height=${Math.max(240, height * view.k + 40)}
          role="img"
          aria-label="Phase dependency map">
          <defs>
            <pattern id="gate-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-gated)" stroke-width="3" opacity="0.5" />
            </pattern>
          </defs>

          <g transform=${`translate(${view.x + 8},${view.y + 8}) scale(${view.k})`}>
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

            ${[...points.values()].map((node) => {
              const dim = related && !related.has(node.phase);
              return html`
                <g
                  key=${node.phase}
                  class=${`station state-${node.state} ${node.state === 'ready' ? 'boarding' : ''} ${dim ? 'dim' : ''} ${selected === node.phase ? 'selected' : ''}`}
                  transform=${`translate(0,0)`}
                  tabindex="0"
                  role="button"
                  aria-label=${`Phase ${node.phase}: ${node.title}, ${STATE_BOARD[node.state] ?? node.state}`}
                  onClick=${() => onSelect?.(node.phase)}
                  onKeyDown=${(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(node.phase); } }}
                  onMouseEnter=${() => setHover(node.phase)}
                  onMouseLeave=${() => setHover(null)}>
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
