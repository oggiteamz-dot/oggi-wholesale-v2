// =============================================================================
// OGGI Wholesale v2 — CHARTS (inline SVG, no library)
// =============================================================================
//
// WHY NO CHART LIBRARY
// --------------------
// Two hard reasons, not preference:
//   1. The app's CSP is `script-src 'self'`. A CDN chart library is blocked
//      outright, and vendoring one means shipping 60-150KB to devices where the
//      median mobile download is 43.9 Mbps and ~13% of traffic is on 2-4GB
//      Android hardware.
//   2. Two chart types are needed. Chart.js is 60KB+ to draw a line and a bar.
//
// WHAT THIS FOLLOWS
// -----------------
// The dataviz method, in its order: form first, colour last, and the palette
// COMPUTED rather than eyeballed.
//
//   - Form: change-over-time -> line. Magnitude/ranking -> horizontal bar.
//   - Marks: 2px lines, 8px markers, 4px rounded data-ends on bars anchored to
//     the baseline, a 2px surface gap between adjacent bars, recessive grid.
//   - Hover ships BY DEFAULT: crosshair + tooltip on the line, per-mark
//     tooltip on the bars. An SVG chart in a browser is interactive; shipping
//     it inert is a choice, and the wrong one.
//   - Legend whenever there are >= 2 series; none for one, because the title
//     already names it. Identity is never colour alone.
//   - Text wears TEXT tokens, never the series colour. A coloured swatch beside
//     a label carries the identity; the label itself stays ink.
//   - NO DUAL AXIS, ever. Two measures of different scale get two charts.
//
// THE PALETTE WAS VALIDATED, NOT CHOSEN BY EYE
// --------------------------------------------
// Run through the dataviz validator against a light surface:
//   lightness band  PASS   chroma floor    PASS
//   CVD separation  PASS   worst adjacent deutan dE 13.0, tritan 10.8
//   normal vision   PASS   worst adjacent dE 30.6
//   contrast        PASS   all >= 3:1
// The ORDER is part of the result -- these hues were reordered until the worst
// adjacent CVD pair cleared the threshold, so do not rearrange them casually.
// Slot 1 is OGGI emerald so the primary series is always on brand.
// =============================================================================

import { esc } from "../lib/utils.js";

/** Fixed categorical order. NEVER cycled -- see overflow handling below. */
export const SERIES_COLORS = [
  "#00845F", // OGGI emerald
  "#7C3AED", // violet
  "#C2410C", // orange
  "#2563EB", // blue
  "#BE185D", // magenta
  "#0891B2", // cyan
];
/** Series beyond the palette fold into this, never into a generated hue. */
export const OVERFLOW_COLOR = "#61727C"; // = --text-tertiary, deliberately mute

const NS = "http://www.w3.org/2000/svg";
function svgEl(name, attrs = {}) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function money(n, currency = "$") {
  return currency + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

/** Axis ticks that land on round numbers rather than on the data's max. */
function niceScale(max, ticks = 4) {
  if (!max || max <= 0) return { max: 1, step: 1 };
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

/** One shared tooltip element per chart. */
function makeTooltip(host) {
  const t = document.createElement("div");
  t.className = "chart-tooltip";
  t.hidden = true;
  host.appendChild(t);
  return t;
}

// =============================================================================
// LINE CHART — change over time, one or more series
// =============================================================================
/**
 * @param {object} o
 * @param {string[]} o.buckets      ISO timestamps, one per x position
 * @param {Array<{name:string,points:number[]}>} o.series
 * @param {string} [o.valueFormat]  "money" | "number"
 */
export function renderLineChart(opts = {}) {
  const host = document.createElement("div");
  host.className = "chart";

  if (!opts.buckets?.length || !opts.series?.length) {
    host.innerHTML = `<div class="chart-empty">Nothing sold in this period.</div>`;
    return host;
  }

  // WHY THE DRAW IS DEFERRED
  // ------------------------
  // The first version used a fixed 720-wide viewBox with
  // preserveAspectRatio="none". That scales the drawing to the container --
  // and scales the TEXT with it, non-uniformly. At 375px the 720 viewBox was
  // squeezed roughly 2x horizontally and every axis label rendered visibly
  // condensed. Caught by looking at the mobile screenshot; no assertion would
  // have found it.
  //
  // Fixing it by preserving the aspect ratio instead would letterbox the chart
  // and waste width on a phone, which is the width that matters most. So the
  // viewBox is built at the container's REAL width: 1 SVG unit = 1 CSS pixel,
  // nothing is stretched, and text renders at its true size.
  //
  // The element has no width until it is in the DOM, so the first draw waits
  // one frame. A debounced ResizeObserver redraws on rotation or a resized
  // window -- without it the chart would keep a stale geometry after the very
  // event most likely to change it.
  let drawnAt = 0;
  const draw = () => {
    const w = Math.max(300, Math.round(host.clientWidth || 720));
    if (Math.abs(w - drawnAt) < 8) return;   // ignore sub-pixel jitter
    drawnAt = w;
    host.querySelectorAll(".chart-svg, .chart-legend, .chart-tooltip").forEach((n) => n.remove());
    drawInto(host, { ...opts, width: w });
  };
  requestAnimationFrame(draw);
  if (typeof ResizeObserver !== "undefined") {
    let t = null;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(draw, 120); }).observe(host);
  }
  return host;
}

function drawInto(host, {
  buckets = [], series = [], valueFormat = "money", currency = "$",
  height = 260, width = 720,
} = {}) {

  const fmt = (v) => (valueFormat === "money" ? money(v, currency)
                                              : Number(v).toLocaleString());

  // Geometry. Left padding fits a y-label; bottom fits one row of dates.
  const W = width, H = height, PAD = { t: 14, r: 14, b: 30, l: 56 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const peak = Math.max(...series.flatMap((s) => s.points), 0);
  const { max: yMax, step } = niceScale(peak);

  const x = (i) => PAD.l + (buckets.length === 1 ? plotW / 2
                             : (i / (buckets.length - 1)) * plotW);
  const y = (v) => PAD.t + plotH - (v / yMax) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, class: "chart-svg",
    // No preserveAspectRatio override: the viewBox now matches the rendered
    // box 1:1, so there is nothing to distort.
    role: "img",
  });
  // A screen reader gets the shape of the data, not "graphic".
  const total = series.reduce((s, ser) => s + ser.points.reduce((a, b) => a + b, 0), 0);
  svg.setAttribute("aria-label",
    `${series.length} series over ${buckets.length} periods, ${fmt(total)} in total. A table of the same figures follows.`);

  // --- recessive grid + y labels ------------------------------------------
  for (let v = 0; v <= yMax; v += step) {
    svg.appendChild(svgEl("line", {
      x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), class: "chart-grid",
    }));
    const lbl = svgEl("text", { x: PAD.l - 8, y: y(v) + 4, class: "chart-axis-label", "text-anchor": "end" });
    lbl.textContent = valueFormat === "money" ? money(v, currency) : String(v);
    svg.appendChild(lbl);
  }

  // --- x labels, thinned so they never collide ----------------------------
  // Roughly one label per 90px. Drawing all of them and letting them overlap
  // is the single most common way a small chart becomes unreadable.
  const everyN = Math.max(1, Math.ceil(buckets.length / Math.floor(plotW / 90)));
  const last = buckets.length - 1;
  // The final label is always worth drawing -- it is the end of the range --
  // but only if it has room. Forcing it unconditionally produced "Jul 20Jul 27"
  // whenever the last bucket happened to sit right after a regular tick.
  // Caught by looking at the rendered chart, not by any assertion.
  const drawLast = last % everyN === 0 || (last % everyN) >= everyN * 0.6;
  buckets.forEach((b, i) => {
    const isRegular = i % everyN === 0;
    const isLast = i === last;
    if (!isRegular && !(isLast && drawLast)) return;
    // If the last label is being drawn on its own, drop the regular tick
    // immediately before it when they would sit closer than a label's width.
    if (isRegular && !isLast && drawLast && last - i < everyN * 0.6) return;
    const t = svgEl("text", { x: x(i), y: H - 10, class: "chart-axis-label", "text-anchor": "middle" });
    t.textContent = new Date(b).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    svg.appendChild(t);
  });

  // --- the series ----------------------------------------------------------
  series.forEach((s, si) => {
    const colour = si < SERIES_COLORS.length ? SERIES_COLORS[si] : OVERFLOW_COLOR;
    const d = s.points.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
    svg.appendChild(svgEl("path", {
      d, fill: "none", stroke: colour, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
    // Markers only when there are few enough points to be legible; past that
    // they turn the line into a caterpillar.
    if (buckets.length <= 30) {
      s.points.forEach((v, i) => {
        svg.appendChild(svgEl("circle", {
          cx: x(i), cy: y(v), r: 4, fill: colour,
          // A 2px surface ring keeps overlapping markers readable.
          stroke: "var(--bg-surface)", "stroke-width": 2,
        }));
      });
    }
  });

  // --- crosshair + hover ---------------------------------------------------
  const crosshair = svgEl("line", { class: "chart-crosshair", y1: PAD.t, y2: PAD.t + plotH, x1: 0, x2: 0 });
  crosshair.style.opacity = "0";
  svg.appendChild(crosshair);
  host.appendChild(svg);
  const tip = makeTooltip(host);

  function nearestIndex(clientX) {
    const r = svg.getBoundingClientRect();
    const rel = ((clientX - r.left) / r.width) * W;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < buckets.length; i++) {
      const d = Math.abs(x(i) - rel);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function showAt(clientX, clientY) {
    const i = nearestIndex(clientX);
    crosshair.setAttribute("x1", x(i));
    crosshair.setAttribute("x2", x(i));
    crosshair.style.opacity = "1";
    const when = new Date(buckets[i]).toLocaleDateString(undefined,
      { day: "numeric", month: "short", year: "numeric" });
    tip.innerHTML =
      `<div class="chart-tooltip-title">${esc(when)}</div>` +
      series.map((s, si) => {
        const c = si < SERIES_COLORS.length ? SERIES_COLORS[si] : OVERFLOW_COLOR;
        return `<div class="chart-tooltip-row">
          <span class="chart-swatch" style="background:${c}"></span>
          <span class="chart-tooltip-name">${esc(s.name)}</span>
          <span class="chart-tooltip-value">${esc(fmt(s.points[i]))}</span>
        </div>`;
      }).join("");
    tip.hidden = false;
    const hr = host.getBoundingClientRect();
    // Flip to the left near the right edge so the tooltip never leaves the card.
    const left = clientX - hr.left;
    tip.style.left = `${Math.min(left + 12, hr.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(8, clientY - hr.top - tip.offsetHeight - 12)}px`;
  }
  function hide() { tip.hidden = true; crosshair.style.opacity = "0"; }

  svg.addEventListener("mousemove", (e) => showAt(e.clientX, e.clientY));
  svg.addEventListener("mouseleave", hide);
  // Touch: the same read, since a phone has no hover.
  svg.addEventListener("touchstart", (e) => {
    const t0 = e.touches[0];
    if (t0) showAt(t0.clientX, t0.clientY);
  }, { passive: true });
  svg.addEventListener("touchend", hide);

  // --- legend (only for >= 2 series) --------------------------------------
  if (series.length >= 2) {
    const legend = document.createElement("div");
    legend.className = "chart-legend";
    series.forEach((s, si) => {
      const c = si < SERIES_COLORS.length ? SERIES_COLORS[si] : OVERFLOW_COLOR;
      const item = document.createElement("span");
      item.className = "chart-legend-item";
      item.innerHTML = `<span class="chart-swatch" style="background:${c}"></span>${esc(s.name)}`;
      legend.appendChild(item);
    });
    host.appendChild(legend);
  }
}

// =============================================================================
// HORIZONTAL BAR — ranking / magnitude
// Horizontal because the labels are product names. Vertical bars force those
// names to rotate, and rotated labels are slow to read.
// =============================================================================
export function renderBarChart({
  rows = [], valueFormat = "money", currency = "$", colour = SERIES_COLORS[0],
} = {}) {
  const host = document.createElement("div");
  host.className = "chart chart-bars";

  if (!rows.length) {
    host.innerHTML = `<div class="chart-empty">Nothing sold in this period.</div>`;
    return host;
  }
  const fmt = (v) => (valueFormat === "money" ? money(v, currency)
                                              : Number(v).toLocaleString());
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const tip = makeTooltip(host);

  rows.forEach((r) => {
    const row = document.createElement("div");
    row.className = "chart-bar-row";
    // The value is a text token, not the bar's colour -- the bar carries the
    // magnitude, the text stays readable ink.
    row.innerHTML = `
      <span class="chart-bar-label" title="${esc(r.label)}">${esc(r.label)}</span>
      <span class="chart-bar-track"><span class="chart-bar-fill"></span></span>
      <span class="chart-bar-value">${esc(fmt(r.value))}</span>`;
    const fill = row.querySelector(".chart-bar-fill");
    fill.style.width = `${Math.max(2, (r.value / max) * 100)}%`;
    fill.style.background = colour;

    row.addEventListener("mouseenter", (e) => {
      tip.innerHTML =
        `<div class="chart-tooltip-title">${esc(r.label)}</div>` +
        (r.detail || []).map((d) =>
          `<div class="chart-tooltip-row"><span class="chart-tooltip-name">${esc(d[0])}</span>
           <span class="chart-tooltip-value">${esc(d[1])}</span></div>`).join("");
      tip.hidden = false;
      const hr = host.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX - hr.left + 12, hr.width - tip.offsetWidth - 8)}px`;
      tip.style.top = `${Math.max(4, e.clientY - hr.top - tip.offsetHeight - 10)}px`;
    });
    row.addEventListener("mouseleave", () => { tip.hidden = true; });

    host.appendChild(row);
  });

  return host;
}
