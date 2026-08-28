// =============================================================================
// OGGI Wholesale v2 — THE ORDER SHEET                  Batch N step 4, 28 Aug
// =============================================================================
// The page a warehouse, a driver, a buyer or an accountant opens from a link,
// with no account and usually on a phone.
//
// FOUR THINGS THIS GETS RIGHT THAT A SCREENSHOT DOES NOT
//
//  1. IT IS ITS OWN PAGE, NOT A ROUTE INSIDE THE APP SHELL. No sidebar, no
//     bottom navigation, no cart badge. Whoever opens this is not a user of
//     this product and should not be shown its furniture.
//
//  2. IT PRINTS. Row-atomic: `break-inside: avoid` on every line, so a size
//     and its quantity are never split across a page break. A picking sheet
//     that tears a line in half is a picking sheet that gets picked wrong.
//     "Save as PDF" is the browser's own print dialog -- every phone and
//     desktop already has a correct one, it produces a file the person names
//     themselves, and it renders exactly what they just looked at.
//
//  3. IT SHOWS THE PACK BOTH WAYS. A warehouse cannot pick "2 x Boutique
//     Pack"; it picks 2 small, 4 medium, 4 large. This is the same rule the
//     wholesaler's own order screen follows (manifest row 136).
//
//  4. IT CARRIES THE BUYER'S WORDS AND NOT THE WAREHOUSE'S. Migration 087
//     made those two separate columns precisely so an internal picking
//     instruction could never reach a customer, and 088 does not return
//     `fulfil_note` at all. There is nothing to filter here, which is the
//     point: the wall is in the database, not in this file.
//
// WHY IT SAYS SO LITTLE ABOUT MONEY
// Prices and the order total are shown because the buyer needs to check them.
// Nothing here can be paid, and nothing pretends otherwise -- Hadi, 24 Aug:
// "there will be no card needed... No money will be paid through this app."
// =============================================================================

import { getOrderByToken, orderLink, whatsappHref } from "../data/order-handoff.js";
import { esc, money } from "../lib/utils.js";
import { toast } from "../components/toast.js";

function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return ""; }
}

/** A pack, shown as a pack AND exploded into the pieces to pick. */
function groupLines(items) {
  const packs = new Map();
  const loose = [];
  items.forEach((it) => {
    if (it.packId) {
      const key = `${it.packId}::${it.packQty}`;
      const g = packs.get(key) || { packId: it.packId, packQty: it.packQty, lines: [] };
      g.lines.push(it);
      packs.set(key, g);
    } else {
      loose.push(it);
    }
  });
  return { packs: [...packs.values()], loose };
}

function lineRow(it, currency) {
  const swatch = it.colorHex
    ? `<span class="os-dot" style="background:${esc(it.colorHex)}"></span>` : "";
  const photo = it.imageUrl
    ? `<img class="po-thumb" src="${esc(it.imageUrl)}" alt="" loading="lazy" decoding="async">`
    : `<span class="po-thumb po-thumb-none" aria-hidden="true">🧵</span>`;
  const what = [it.color, it.size].filter(Boolean).map(esc).join(" · ");
  return `
    <li class="po-line">
      ${photo}
      <div class="po-line-what">
        <div class="po-line-name">${esc(it.productName || "Product")}</div>
        <div class="po-line-variant">${swatch}${what || esc(it.sku || "")}</div>
        ${it.buyerNote ? `<div class="po-line-note"><span>They asked</span>${esc(it.buyerNote)}</div>` : ""}
      </div>
      <div class="po-line-qty"><strong>${Number(it.qty)}</strong><span>pcs</span></div>
      <div class="po-line-money">
        <div>${money(Number(it.unitPrice), currency)}</div>
        <strong>${money(Number(it.lineTotal), currency)}</strong>
      </div>
    </li>`;
}

export async function orderSheetView(outlet, params) {
  const token = params?.token;
  outlet.className = "po-page";
  outlet.innerHTML = `<div class="po-loading">Opening the order…</div>`;

  const res = await getOrderByToken(token);

  if (res.status !== "ok") {
    // A dead link and an invented link say the SAME thing, deliberately.
    // Telling them apart tells a stranger whether an order exists.
    outlet.innerHTML = `
      <div class="po-empty">
        <div class="po-empty-icon">🔗</div>
        <h1>This link doesn't work any more</h1>
        <p>It may have been replaced with a newer one, or it may never have been a real link. Ask whoever sent it to you for a fresh one.</p>
      </div>`;
    return;
  }

  const { packs, loose } = groupLines(res.items);
  const pieces = res.items.reduce((n, it) => n + Number(it.qty || 0), 0);
  const ref = String(res.orderId || "").slice(0, 8).toUpperCase();

  outlet.innerHTML = `
    <article class="po-sheet">
      <header class="po-head">
        <div>
          <div class="po-eyebrow">Order ${esc(ref)}</div>
          <h1>${esc(res.wholesalerName || "Order")}</h1>
          <p class="po-sub">${esc(res.buyerLabel || "")} · ${esc(fmtDate(res.createdAt))} · <span class="po-status po-status-${esc(res.orderStatus)}">${esc(res.orderStatus)}</span></p>
        </div>
        <div class="po-tally">
          <strong>${pieces}</strong> <span>pieces</span>
        </div>
      </header>

      ${res.buyerOrderNote ? `
      <section class="po-note">
        <span class="po-note-label">What they asked for</span>
        <p>${esc(res.buyerOrderNote)}</p>
      </section>` : ""}

      ${packs.map((g) => {
        const inside = g.lines.reduce((n, l) => n + Number(l.qty || 0), 0);
        return `
        <section class="po-pack">
          <div class="po-pack-head">
            <strong>${g.packQty} × box</strong>
            <span>${inside} pieces inside — pick each line below</span>
          </div>
          <ul class="po-lines">${g.lines.map((l) => lineRow(l, res.currency)).join("")}</ul>
        </section>`;
      }).join("")}

      ${loose.length ? `<ul class="po-lines">${loose.map((l) => lineRow(l, res.currency)).join("")}</ul>` : ""}

      <footer class="po-foot">
        <div class="po-total">
          <span>Order total</span>
          <strong>${money(res.subtotal, res.currency)}</strong>
        </div>
        <p class="po-terms">Nothing is paid here. ${esc(res.wholesalerName || "The wholesaler")} invoices you the way they always do.</p>
      </footer>
    </article>

    <div class="po-actions no-print">
      <button type="button" class="btn btn-primary" data-a="print">Print / Save as PDF</button>
      <a class="btn btn-secondary" data-a="wa" href="${esc(whatsappHref(token, { orderRef: ref, wholesalerName: res.wholesalerName }))}" target="_blank" rel="noopener">Send on WhatsApp</a>
      <button type="button" class="btn btn-secondary" data-a="copy">Copy link</button>
    </div>
  `;

  outlet.querySelector('[data-a="print"]').addEventListener("click", () => window.print());

  outlet.querySelector('[data-a="copy"]').addEventListener("click", async () => {
    const url = orderLink(token);
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied", { type: "success" });
    } catch {
      // execCommand fallback: clipboard.writeText needs a secure context AND
      // a permission that some in-app browsers (Instagram, Facebook) refuse.
      // Those in-app browsers are exactly where a WhatsApp link gets opened.
      // Mounted inside the page's own outlet, for the same reason as the
      // wholesaler side: nothing this app writes should append to body
      // directly, so the rule never has to judge intent.
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("aria-hidden", "true");
      ta.tabIndex = -1;
      ta.style.cssText = "position:absolute;left:-9999px;opacity:0;height:1px;width:1px;";
      outlet.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("Link copied", { type: "success" }); }
      catch { toast("Copy failed — long-press the address bar instead", { type: "danger" }); }
      ta.remove();
    }
  });
}

/** Routes that work with NO SESSION AT ALL.
 *
 *  Registered by js/app.js BEFORE the login gate. Until this existed, every
 *  public route in the app was unreachable while signed out: mountShell()
 *  rendered the login screen and RETURNED before registering a single route,
 *  so /c/:token -- the catalogue share link, the entire delivery mechanism for
 *  a catalogue -- resolved to nothing for anyone without an account. That bug
 *  had been live since share links shipped on 19 Aug. */
export function registerPublicRoutes(router) {
  router.register("/o/:token", (outlet, params) => orderSheetView(outlet, params));
}

/** Does this path need no session? Asked by app.js before it decides to show
 *  the login screen. Kept here, beside the routes, so a new public route
 *  cannot be added without the answer changing with it. */
export function isPublicPath(path) {
  return /^\/o\/[^/]+$/.test(path || "") || /^\/c\/[^/]+$/.test(path || "");
}
