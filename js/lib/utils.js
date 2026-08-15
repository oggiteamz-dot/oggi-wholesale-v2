// OGGI Wholesale v2 — shared UI utilities
//
// WHY THIS FILE EXISTS
// --------------------
// Before this module, the same three helpers were copy-pasted across the
// codebase: the HTML-escape helper existed in TEN copies under FOUR different
// names (esc, escapeHtml, escapeHtmlLocal, escapeHtmlSp), pageHeader in SEVEN,
// and the money formatter in two. Two files (wholesaler.js, salesperson.js)
// each contained two identical copies of the escape helper *within the same
// file* -- one file disagreeing with itself.
//
// That is not a tidiness problem, it is a defect generator, and it had already
// produced two real defects:
//
//   1. DRIFT. Four copies of pageHeader rendered a `page-actions` slot and
//      three did not, so mobile-ops, integrations and import-catalog were
//      three screens that structurally COULD NOT host a page-level action
//      button. Nobody decided that -- someone updated four files and stopped.
//
//   2. AN UNESCAPED SINK. Every pageHeader copy wrote its title and
//      description straight into innerHTML with no escaping, while an escape
//      helper sat unused a few lines above it in the same file. Live data
//      reached it from three call sites (a wholesaler's brand name, shown to
//      every buyer; and a buyer's label, shown on the warehouse picking
//      screen). A Content-Security-Policy of `script-src 'self'` with no
//      `unsafe-inline` meant injected script could not execute -- so this was
//      HTML injection with a backstop, not stored XSS -- but relying on a CSP
//      to cover unescaped output is one header edit away from being wrong.
//
// With one definition, the next fix to escaping lands everywhere at once.
// That is the whole point.

/**
 * Escape a value for safe inclusion in HTML.
 *
 * Handles null/undefined by producing an empty string, so callers never have
 * to guard. Escapes the five characters that matter in both element text and
 * quoted attribute values, which is why the same function is safe in both
 * positions.
 *
 * This replaces: esc(), escapeHtml(), escapeHtmlLocal(), escapeHtmlSp().
 * All ten former copies were behaviourally identical, so swapping them for
 * this one changes no behaviour -- it only removes the ability to drift.
 */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

/**
 * Format a number as money.
 *
 * Replaces money() and moneyLocal(). Returns an em dash for null/undefined so
 * "no price set" is visually distinct from a price of zero -- a real
 * distinction in wholesale, where 0.00 can be a deliberate promotional price.
 */
export function money(n, currency = "$") {
  if (n === null || n === undefined || n === "") return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return `${currency}${num.toFixed(2)}`;
}

/**
 * Build a page header element.
 *
 * SECURITY: `title` and `desc` are ESCAPED. Every previous copy interpolated
 * them raw. Callers that were passing plain literals are unaffected; callers
 * passing live data (a wholesaler's brand name, a buyer's label) are now safe
 * by default rather than safe by the caller remembering.
 *
 * `actionsHtml` is deliberately NOT escaped -- it is a slot for
 * developer-authored markup (buttons, links) and escaping it would break every
 * caller. It is therefore unsafe-by-contract: never pass user data into it.
 * If you need a user-supplied value inside an action, escape it yourself with
 * esc() at that point.
 *
 * The `actionsHtml` parameter is always accepted here. Three of the seven
 * former copies omitted it, which silently denied those screens a page-level
 * action slot; that inconsistency is resolved in favour of the capability, and
 * the slot renders empty when unused, so no existing layout changes.
 */
export function pageHeader(title, desc, actionsHtml = "") {
  const el = document.createElement("div");
  el.className = "page-header";
  el.innerHTML =
    `<div class="page-title-group"><h1>${esc(title)}</h1><p>${esc(desc)}</p></div>` +
    `<div class="page-actions">${actionsHtml}</div>`;
  return el;
}
