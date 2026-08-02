/**
 * Hand-drawn SVG charts. One accent hue per meaning, tabular figures, no
 * decoration that does not carry data.
 */

import { html, useState } from '../html.js';

/** Weekly completions. Amber marks the current week. */
export function Bars({ data, height = 92, label = 'completions' }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const width = 100;
  const gap = 1.2;
  const barWidth = Math.max(0.8, width / data.length - gap);

  return html`
    <svg class="chart" viewBox=${`0 0 ${width} ${height}`} preserveAspectRatio="none" height=${height}
         role="img" aria-label=${`${label} per week`}>
      ${data.map((point, i) => {
        const barHeight = (point.count / max) * (height - 14);
        return html`
          <rect
            key=${point.week ?? i}
            class=${`bar ${i === data.length - 1 ? 'hot' : ''}`}
            x=${i * (barWidth + gap)}
            y=${height - 12 - barHeight}
            width=${barWidth}
            height=${Math.max(point.count ? 1.5 : 0, barHeight)}
            rx="0.6">
            <title>${`${point.week}: ${point.count} ${label}`}</title>
          </rect>`;
      })}
      <line class="axis" x1="0" y1=${height - 11} x2=${width} y2=${height - 11} />
    </svg>`;
}

/** A year of phase completions, one square per day. */
export function Calendar({ data, weeks = 26 }) {
  const byDate = new Map(data.map((d) => [d.date, d.count]));
  const max = Math.max(1, ...data.map((d) => d.count));
  const [hover, setHover] = useState(null);

  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - weeks * 7 - start.getUTCDay());

  const cells = [];
  for (let w = 0; w <= weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + w * 7 + d);
      if (date > today) continue;
      const key = date.toISOString().slice(0, 10);
      const count = byDate.get(key) ?? 0;
      cells.push({ key, count, x: w * 11, y: d * 11, intensity: count ? 0.25 + (count / max) * 0.75 : 0 });
    }
  }

  return html`
    <div>
      <svg class="chart" viewBox=${`0 0 ${(weeks + 1) * 11} 78`} height="86" role="img" aria-label="Phase completions by day">
        ${cells.map((cell) => html`
          <rect
            key=${cell.key}
            class="heatmap-cell"
            x=${cell.x} y=${cell.y} width="9" height="9"
            fill=${cell.count ? `color-mix(in oklab, var(--line-done) ${Math.round(cell.intensity * 100)}%, var(--track))` : 'var(--track)'}
            onMouseEnter=${() => setHover(cell)}
            onMouseLeave=${() => setHover(null)}>
            <title>${`${cell.key}: ${cell.count} phase${cell.count === 1 ? '' : 's'}`}</title>
          </rect>`)}
      </svg>
      <div class="faint" style="font-size:var(--text-xs);min-height:1.2em">
        ${hover ? `${hover.key} · ${hover.count} phase${hover.count === 1 ? '' : 's'} completed` : `last ${weeks} weeks`}
      </div>
    </div>`;
}

/** Ranked horizontal bars — repos, skills, models. */
export function BarList({ items, unit = '' }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return html`
    <div class="bar-list">
      ${items.map((item) => html`
        <div class="bar-row" key=${item.name}>
          <span class="name" title=${item.name}>${item.name}</span>
          <span class="track-bar"><span style=${`width:${(item.value / max) * 100}%`}></span></span>
          <span class="value">${item.value}${unit}</span>
        </div>`)}
    </div>`;
}

/** Proportional stack — the size mix, the status split. */
export function StackBar({ segments }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  return html`
    <div>
      <div class="progress" style="height:10px">
        ${segments.map((segment) => html`
          <span
            key=${segment.label}
            style=${`width:${(segment.value / total) * 100}%;background:${segment.color}`}
            title=${`${segment.label}: ${segment.value}`}></span>`)}
      </div>
      <div class="row-wrap" style="margin-top:var(--s2)">
        ${segments.map((segment) => html`
          <span class="chip plain" key=${segment.label}>
            <span class="dot" style=${`background:${segment.color}`}></span>${segment.label} ${segment.value}
          </span>`)}
      </div>
    </div>`;
}
