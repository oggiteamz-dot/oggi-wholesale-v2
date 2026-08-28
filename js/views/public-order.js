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
import { inviteByToken, redeemBuyerInvite } from "../data/buyer-invites.js";
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

// =============================================================================
// ACCEPTING AN INVITATION                                 AC-03, 29 Aug 2026
// =============================================================================
// The page an invited shop lands on. They have no account -- that is the
// entire point -- so this must work with no session, which is why it lives
// beside the order sheet in the public routes rather than anywhere behind the
// login gate.
//
// FOUR THINGS FROM THE 28 AUG COMPLAINT RESEARCH
//
//  1. IT SAYS WHO INVITED THEM, FIRST. A link arriving on WhatsApp with no
//     context is a link nobody taps. The wholesaler's name is the only reason
//     to trust it.
//
//  2. A DEAD LINK SAYS WHICH KIND OF DEAD. Withdrawn, already used, and
//     expired read differently, because each one tells the shop something they
//     can act on. This is the OPPOSITE of the order sheet, deliberately: an
//     order link may be in a stranger's hands, so a dead one and a fake one
//     must read alike. An invitation is held by someone the wholesaler chose
//     to contact.
//
//  3. THE FORM IS THREE FIELDS. Cartona's number, from the research: before
//     they moved verification after login, only 14.24% of installs became
//     registrations and 99% of the rest left. Every field is a place to leave.
//
//  4. IT NEVER SAYS "ERROR". It says what happened and what to do next, which
//     is the only useful thing a failure can do.
// =============================================================================
export async function inviteView(outlet, params) {
  const token = params?.token;
  outlet.className = "po-page";
  outlet.innerHTML = `<div class="po-loading">Opening your invitation…</div>`;

  const inv = await inviteByToken(token);

  const dead = {
    withdrawn: {
      icon: "🔒",
      title: "This invitation was withdrawn",
      body: (w) => `${w || "The wholesaler"} cancelled this invitation. If you think that was a mistake, message them and ask for a new link.`,
    },
    used: {
      icon: "✅",
      title: "This invitation has already been used",
      body: (w) => `An account was created with this link. If it was you, sign in instead. If it was not, tell ${w || "the wholesaler"} straight away.`,
    },
    expired: {
      icon: "⌛",
      title: "This invitation has expired",
      body: (w) => `Links last 30 days. Ask ${w || "the wholesaler"} to send you a new one — it takes them a moment.`,
    },
    not_found: {
      icon: "🔗",
      title: "This link doesn't work",
      body: () => "It may have been typed slightly wrong, or it may never have been a real link. Ask whoever sent it to you for a fresh one.",
    },
  };

  if (inv.status !== "ok") {
    const d = dead[inv.status] || dead.not_found;
    outlet.innerHTML = `
      <div class="po-empty">
        <div class="po-empty-icon">${d.icon}</div>
        <h1>${esc(d.title)}</h1>
        <p>${esc(d.body(inv.wholesalerName))}</p>
      </div>`;
    return;
  }

  outlet.innerHTML = `
    <article class="po-sheet inv-card">
      <header class="po-head">
        <div>
          <div class="po-eyebrow">Invitation</div>
          <h1>${esc(inv.wholesalerName)}</h1>
          <p class="po-sub">has set up an account for you to order online.</p>
        </div>
      </header>
      <form class="inv-form" novalidate>
        <label class="inv-field">
          <span>Your shop's name</span>
          <input class="input" name="shop" type="text" autocomplete="organization"
                 value="${esc(inv.shopName || "")}" required>
        </label>
        <label class="inv-field">
          <span>Choose a username</span>
          <input class="input" name="username" type="text" autocomplete="username"
                 autocapitalize="none" spellcheck="false" required>
        </label>
        <label class="inv-field">
          <span>Choose a password</span>
          <input class="input" name="password" type="password" autocomplete="new-password" required>
          <small>At least 6 characters.</small>
        </label>
        <div class="inv-msg" data-slot="msg" role="alert"></div>
        <button type="submit" class="btn btn-primary inv-go">Create my account</button>
        <p class="po-terms">Nothing is paid here. ${esc(inv.wholesalerName)} invoices you the way they always do.</p>
      </form>
    </article>
  `;

  const form = outlet.querySelector("form");
  const msg = outlet.querySelector('[data-slot="msg"]');
  const go = outlet.querySelector(".inv-go");

  // Looked up explicitly rather than through form.shop / form.username.
  //
  // Named form access is a real browser feature, but it is a footgun -- a
  // field named "submit" or "action" shadows the form's own method or
  // property, and the failure is silent. It is also not implemented by jsdom,
  // so it cannot be exercised by a gate: code no check can reach is code that
  // drifts. Explicit lookups fix both at once.
  const fShop = form.querySelector('[name="shop"]');
  const fUser = form.querySelector('[name="username"]');
  const fPass = form.querySelector('[name="password"]');

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const shop = fShop.value.trim();
    const username = fUser.value.trim();
    const password = fPass.value;

    // Checked here so the answer is instant, and checked again in the database
    // so a stray call cannot make a half-record. The message names the field.
    if (!shop) { msg.textContent = "Please give your shop's name."; fShop.focus(); return; }
    if (username.length < 3) { msg.textContent = "Your username needs at least 3 characters."; fUser.focus(); return; }
    if (password.length < 6) { msg.textContent = "Your password needs at least 6 characters."; fPass.focus(); return; }

    go.disabled = true;
    const before = go.textContent;
    go.textContent = "Creating your account…";
    msg.textContent = "";

    const res = await redeemBuyerInvite(token, { shopName: shop, username, password });
    if (!res.ok) {
      // The server's own words. It knows things this form cannot -- that the
      // username is taken for this store, that the link was used while they
      // were typing -- and it says them in plain language.
      msg.textContent = res.error || "That did not work. Please try again.";
      go.disabled = false;
      go.textContent = before;
      return;
    }

    outlet.innerHTML = `
      <div class="po-empty">
        <div class="po-empty-icon">🎉</div>
        <h1>You're in</h1>
        <p>Your account with ${esc(inv.wholesalerName)} is ready. Sign in with the username and password you just chose.</p>
        <a class="btn btn-primary" href="#/" style="margin-top:14px;display:inline-flex;">Sign in</a>
      </div>`;
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
  // AC-03: accepting an invitation. No session, by definition.
  router.register("/i/:token", (outlet, params) => inviteView(outlet, params));
}

/** Does this path need no session? Asked by app.js before it decides to show
 *  the login screen. Kept here, beside the routes, so a new public route
 *  cannot be added without the answer changing with it. */
export function isPublicPath(path) {
  return /^\/o\/[^/]+$/.test(path || "")   // an order handed to a warehouse
      || /^\/c\/[^/]+$/.test(path || "")   // a catalogue share link
      || /^\/i\/[^/]+$/.test(path || "");  // an invitation to join a store
}
