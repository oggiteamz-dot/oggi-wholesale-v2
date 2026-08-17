// =============================================================================
// OGGI Wholesale v2 — DATE RANGE FILTER
// =============================================================================
//
// Hadi's ask, verbatim: "I get to put the time frame? How many orders this
// week, this month, the past six months, the past year, or a custom date that
// I put in or a lifetime and so on."
//
// WHY IT IS A COMPONENT AND NOT PART OF THE DRILL-DOWN
// ---------------------------------------------------
// The v1->v2 regression audit found THREE separate screens with no date filter
// at all -- the owner's orders, the wholesaler's orders and the salesperson's
// orders (finding #18). Building this as a shared component means those three
// become a one-line import later instead of three copies that drift.
//
// That is not a hypothetical worry in this codebase: the HTML-escape helper
// exists in 10 copies under 4 names, and pageHeader in 7 copies that have
// ALREADY diverged -- 4 render a page-actions slot and 3 do not.
//
// WHAT IT EMITS
// -------------
// { key, label, from, to } where `from`/`to` are ISO strings or null.
// NULL MEANS UNBOUNDED, and "lifetime" is simply { from: null, to: null }
// rather than a special case the caller has to know about. The SQL functions
// in migration 039 take the same convention, so the value passes straight
// through with no translation layer in between -- one fewer place to get an
// off-by-one wrong.
//
// TIME ZONES, STATED PLAINLY
// --------------------------
// Boundaries are computed in the BROWSER'S local zone and sent as absolute
// instants. "This month" for a wholesaler in Beirut is Beirut's month. That is
// the honest behaviour for a single-operator console, and it is written down
// because the day OGGI has staff in two countries looking at the same number,
// this is where the discrepancy will come from.
//
// Ranges are half-open: from <= t < to. That is why "today" ends at tomorrow
// 00:00 rather than 23:59:59 -- the classic bug where an order placed at
// 23:59:30 silently falls outside "today".
// =============================================================================

import { esc } from "../lib/utils.js";

/** Local midnight N days ago. Mutating a copy, never the argument. */
function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

/**
 * The presets, newest-scope first. Each returns [from, to] as Date or null.
 *
 * `to` is always exclusive. Using "now" as the upper bound instead of
 * tomorrow-midnight would exclude an order placed one second from now while
 * the operator is reading the screen -- a real cause of "the numbers changed
 * when I refreshed and nothing happened".
 */
export const RANGE_PRESETS = [
  { key: "today", label: "Today",
    range: () => [startOfDay(), addDays(startOfDay(), 1)] },
  { key: "7d", label: "This week",
    range: () => [addDays(startOfDay(), -6), addDays(startOfDay(), 1)] },
  { key: "30d", label: "This month",
    range: () => [addDays(startOfDay(), -29), addDays(startOfDay(), 1)] },
  { key: "6m", label: "6 months",
    range: () => [addMonths(startOfDay(), -6), addDays(startOfDay(), 1)] },
  { key: "12m", label: "This year",
    range: () => [addMonths(startOfDay(), -12), addDays(startOfDay(), 1)] },
  { key: "all", label: "Lifetime",
    range: () => [null, null] },
  { key: "custom", label: "Custom", range: null },
];

/**
 * Picks a sensible time bucket for a range, so the chart never draws 400
 * one-pixel columns or three fat ones.
 *
 * Aiming for roughly 10-60 buckets. This is a presentation decision, not a
 * data one -- the SQL will honour whatever bucket it is given.
 */
export function bucketForRange(from, to) {
  if (!from) return "month";                 // lifetime: months, always
  const days = Math.max(1, Math.round((new Date(to || Date.now()) - new Date(from)) / 86400000));
  if (days <= 2)  return "hour";
  if (days <= 45) return "day";
  if (days <= 400) return "week";
  return "month";
}

/**
 * @param {object} opts
 * @param {string} [opts.initial]   preset key to start on
 * @param {function} opts.onChange  called with { key, label, from, to, bucket }
 */
export function renderDateRangeFilter({ initial = "30d", onChange = () => {} } = {}) {
  const el = document.createElement("div");
  el.className = "date-range";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Time frame");

  const row = document.createElement("div");
  row.className = "date-range-row";
  el.appendChild(row);

  // The custom pair lives in its own row, hidden until asked for. Showing two
  // empty date inputs permanently is clutter for the 90% case that uses a
  // preset.
  const customRow = document.createElement("div");
  customRow.className = "date-range-custom";
  customRow.hidden = true;
  customRow.innerHTML = `
    <label class="date-range-label" for="dr-from">From</label>
    <input class="input" type="date" id="dr-from">
    <label class="date-range-label" for="dr-to">To</label>
    <input class="input" type="date" id="dr-to">
  `;
  el.appendChild(customRow);

  const note = document.createElement("div");
  note.className = "date-range-note";
  el.appendChild(note);

  let currentKey = initial;

  function currentValue() {
    const preset = RANGE_PRESETS.find((p) => p.key === currentKey);
    let from = null, to = null;

    if (currentKey === "custom") {
      const f = customRow.querySelector("#dr-from").value;
      const t = customRow.querySelector("#dr-to").value;
      from = f ? startOfDay(new Date(f + "T00:00:00")) : null;
      // The user means "include this day", so the exclusive bound is the day
      // AFTER the one they typed. Without this, picking the same date twice
      // returns nothing and looks broken.
      to = t ? addDays(startOfDay(new Date(t + "T00:00:00")), 1) : null;
    } else if (preset?.range) {
      [from, to] = preset.range();
    }

    return {
      key: currentKey,
      label: preset?.label || "Custom",
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      bucket: bucketForRange(from, to),
    };
  }

  function describe(v) {
    if (!v.from && !v.to) return "All time, every order ever placed.";
    const fmt = (iso) => new Date(iso).toLocaleDateString(undefined,
      { day: "numeric", month: "short", year: "numeric" });
    // The upper bound is exclusive, so the last DAY included is one day back.
    // Showing the raw exclusive bound would tell the operator the range runs a
    // day longer than it does.
    const lastDay = v.to ? fmt(addDays(new Date(v.to), -1).toISOString()) : "now";
    return `${v.from ? fmt(v.from) : "the beginning"} — ${lastDay}`;
  }

  function emit() {
    const v = currentValue();
    note.textContent = describe(v);
    onChange(v);
  }

  function paint() {
    row.innerHTML = "";
    RANGE_PRESETS.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm " + (p.key === currentKey ? "btn-primary" : "btn-secondary");
      b.textContent = p.label;
      // Announced as a selected option rather than just a highlighted button.
      b.setAttribute("aria-pressed", String(p.key === currentKey));
      b.addEventListener("click", () => {
        currentKey = p.key;
        customRow.hidden = p.key !== "custom";
        paint();
        // A freshly-opened custom range has no dates yet, which would mean
        // "lifetime" -- so don't fire until the operator has typed something.
        if (p.key !== "custom") emit();
      });
      row.appendChild(b);
    });
    row.setAttribute("aria-label", `Time frame: ${esc(currentValue().label)}`);
  }

  customRow.addEventListener("change", () => {
    if (currentKey === "custom") emit();
  });

  paint();
  note.textContent = describe(currentValue());

  return {
    el,
    getValue: currentValue,
    /** Fires onChange with the current value. Used once on mount. */
    trigger: emit,
  };
}
