// OGGI Wholesale v2 — trust/guarantee messaging (Batch 8)
// Shown at cart/checkout (Research-driven UX ask: reassure a buyer right
// before they commit to a wholesale order, which is a bigger financial
// decision than a retail cart). Two layers: three generic, always-true
// badges that apply to every wholesaler on this platform (verified
// directory listing, real-time inventory, atomic order submission), plus
// wholesaler-specific payment-terms/return-policy copy pulled from
// v2_wholesalers (migrations/013). The wholesaler-specific copy is ONLY
// shown when the wholesaler has actually filled it in -- never a fabricated
// default that would misrepresent their real policy.

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** `compact` renders just the 3 generic badges inline (used at the top of
 * the catalog grid); the full card (used in the cart) also shows
 * wholesaler-specific payment terms / return policy when set. */
export function renderTrustBadges(wholesaler, { compact = false } = {}) {
  const badges = [
    "✓ Verified wholesaler",
    "✓ Real-time inventory",
    "✓ Secure order submission",
  ];

  if (compact) {
    const el = document.createElement("div");
    el.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-tertiary);margin-bottom:10px;";
    el.innerHTML = badges.map((b) => `<span>${b}</span>`).join("");
    return el;
  }

  const el = document.createElement("div");
  el.className = "card";
  el.style.cssText = "padding:16px;margin-top:14px;display:flex;flex-direction:column;gap:8px;";

  const badgeRow = document.createElement("div");
  badgeRow.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);font-weight:600;";
  badgeRow.innerHTML = badges.map((b) => `<span>${b}</span>`).join("");
  el.appendChild(badgeRow);

  const details = [];
  if (wholesaler?.payment_terms) details.push(`<div><strong>Payment terms:</strong> ${esc(wholesaler.payment_terms)}</div>`);
  if (wholesaler?.return_policy) details.push(`<div><strong>Returns:</strong> ${esc(wholesaler.return_policy)}</div>`);
  if (wholesaler?.trust_message) details.push(`<div>${esc(wholesaler.trust_message)}</div>`);

  if (details.length) {
    const detailBox = document.createElement("div");
    detailBox.style.cssText = "font-size:12px;color:var(--text-secondary);line-height:1.6;border-top:1px solid var(--border-subtle);padding-top:8px;";
    detailBox.innerHTML = details.join("");
    el.appendChild(detailBox);
  }

  return el;
}
