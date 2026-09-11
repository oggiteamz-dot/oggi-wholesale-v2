// =============================================================================
// OGGI Wholesale v2 — THE FINANCE DESK                         Block 7, 11 Sep 2026
// =============================================================================
// Hadi, 11 Sep 2026: "And another one for the accountant or the finance manager
// as well."
//
// Migration 088 named this person on 28 August as somebody the product could not
// serve -- "an accountant, who wants a PDF" -- and handed them an unguessable
// link instead. A link has no queue, no aging and nowhere to write down that the
// money arrived. This is the account they never had.
//
// ==== 🛑 THIS APP TAKES NO MONEY, AND THIS SCREEN MUST NOT CHANGE THAT ======
//
// Hadi, 24 Aug 2026 (checks/check_no_payment_path.mjs): "No money will be paid
// through this app at the moment."
//
// Everything here is BOOKKEEPING AFTER THE FACT. The finance manager types in
// what already arrived in the bank. There is no processor, no card field, no
// charge, and -- the line that matters most -- NOTHING A BUYER CAN REACH. A
// buyer who could record their own payment would have been handed a "pay"
// button with extra steps. checks/check_finance_records_not_charges.mjs asserts
// that no buyer-facing module imports any of this.
//
// ==== ⚠️ AND A MISSING COST IS "WE DO NOT KNOW", NEVER ZERO =================
//
// Not every variant carries a cost. Treating a missing one as 0 reports 100%
// margin, which is the most flattering possible lie and the one a business
// makes decisions on. So every margin figure on this screen is shown WITH THE
// PROPORTION OF THE ORDER IT ACTUALLY COVERS, and an order with no costed lines
// at all shows no margin rather than a confident zero.
// =============================================================================

import { esc, pageHeader, money } from "../lib/utils.js";
import { emptyState } from "../components/empty-state.js";
import { toast } from "../components/toast.js";
import { ask } from "../components/ask.js";
import {
  financeQueue, financeAging, financeOrderHead, financeOrderLines,
  moneyReceivedFor, recordMoneyReceived, deskAccept, deskComplete, deskReturn, deskNote,
} from "../data/desk.js";
import { readDeskSession } from "../data/staff-auth.js";

const METHOD_LABEL = {
  cash: "Cash", bank: "Bank transfer", cheque: "Cheque",
  card_offline: "Card (taken elsewhere)", other: "Other",
};

function session() { return readDeskSession(); }

function ageBadge(days) {
  if (days > 90) return ["badge-danger", "90+ days"];
  if (days > 60) return ["badge-warning", "61–90 days"];
  if (days > 30) return ["badge-warning", "31–60 days"];
  return ["badge-info", `${days} day${days === 1 ? "" : "s"}`];
}

function tabs(active) {
  const wrap = document.createElement("div");
  wrap.className = "sub-tabs";
  wrap.style.cssText = "display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;";
  [["#/finance", "Orders"], ["#/finance/aging", "Who owes what"]].forEach(([href, label]) => {
    const a = document.createElement("a");
    a.href = href;
    a.className = "btn " + (href.endsWith(active) ? "btn-primary" : "btn-secondary");
    a.textContent = label;
    a.style.cssText = "min-height:44px;display:inline-flex;align-items:center;";
    wrap.appendChild(a);
  });
  return wrap;
}

// =================================================================== THE QUEUE
async function queueView(outlet) {
  const s = session();
  if (!s) { outlet.appendChild(emptyState({ icon: "🔒", title: "Please sign in", body: "This screen is for the finance desk." })); return; }

  outlet.appendChild(pageHeader("Finance", `${esc(s.wholesalerName || s.wid)} — oldest first`));
  outlet.appendChild(tabs("/finance"));

  const rows = await financeQueue(s.staffId);
  const cur = rows[0]?.currency || "$";
  const owed = rows.reduce((a, r) => a + r.outstanding, 0);
  const got  = rows.reduce((a, r) => a + r.received, 0);

  const strip = document.createElement("div");
  strip.className = "stat-grid";
  [["Orders on this desk", String(rows.length)],
   ["Outstanding", money(owed, cur)],
   ["Received against these", money(got, cur)]]
    .forEach(([label, value]) => {
      const c = document.createElement("div");
      c.className = "card stat-card";
      c.innerHTML = `<div class="stat-value">${esc(value)}</div>
                     <div class="stat-label">${esc(label)}</div>`;
      strip.appendChild(c);
    });
  outlet.appendChild(strip);

  if (!rows.length) {
    outlet.appendChild(emptyState({
      icon: "🧾",
      title: "Nothing on this desk",
      body: "When the office sends an order to finance it appears here. "
          + "If you are expecting one, ask them to send it.",
    }));
    return;
  }

  const list = document.createElement("div");
  list.setAttribute("data-testid", "finance-queue");

  rows.forEach((r) => {
    const [cls, label] = ageBadge(r.daysOld);
    const a = document.createElement("a");
    a.className = "card";
    a.href = `#/finance/order/${encodeURIComponent(r.orderId)}`;
    a.setAttribute("data-order-id", r.orderId);
    a.style.cssText = "display:block;padding:14px;margin-bottom:10px;min-height:64px;text-decoration:none;color:inherit;";
    a.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
        <strong style="font-size:15px;letter-spacing:.02em;">${esc(r.reference)}</strong>
        <span class="badge ${esc(cls)}">${esc(label)}</span>
        <span style="margin-left:auto;font-weight:700;font-size:15px;">${esc(money(r.outstanding, r.currency))}</span>
      </div>
      <div style="margin-top:4px;font-size:14px;">${esc(r.buyerLabel || "—")}</div>
      <div style="margin-top:6px;font-size:12px;color:var(--text-secondary);">
        ${esc(money(r.subtotal, r.currency))} ordered${r.received > 0 ? ` · ${esc(money(r.received, r.currency))} received` : ""}
        · ${esc(new Date(r.placedAt).toLocaleDateString())}
      </div>`;
    list.appendChild(a);
  });
  outlet.appendChild(list);
}

// ==================================================================== AGING
async function agingView(outlet) {
  const s = session();
  if (!s) { outlet.appendChild(emptyState({ icon: "🔒", title: "Please sign in", body: "This screen is for the finance desk." })); return; }

  outlet.appendChild(pageHeader("Who owes what", "Outstanding by shop, oldest money first"));
  outlet.appendChild(tabs("/finance/aging"));

  const rows = await financeAging(s.staffId);
  if (!rows.length) {
    outlet.appendChild(emptyState({
      icon: "✅",
      title: "Nothing outstanding",
      body: "Every order on this desk has been paid in full, or nothing has been sent here yet.",
    }));
    return;
  }

  const cur = rows[0].currency || "$";
  const total = rows.reduce((a, r) => a + r.outstanding, 0);

  const head = document.createElement("div");
  head.className = "card";
  head.style.cssText = "padding:14px;margin-bottom:12px;";
  head.innerHTML = `<div style="font-size:24px;font-weight:700;">${esc(money(total, cur))}</div>
                    <div style="font-size:12px;color:var(--text-secondary);">owed across ${esc(String(rows.length))} shop${rows.length === 1 ? "" : "s"}</div>`;
  outlet.appendChild(head);

  // A table that scrolls inside itself rather than making the page scroll
  // sideways -- css/components.css's rule and check_contrast/touch gates.
  const wrap = document.createElement("div");
  wrap.style.cssText = "overflow-x:auto;-webkit-overflow-scrolling:touch;";
  const t = document.createElement("table");
  t.className = "table";
  t.setAttribute("data-testid", "finance-aging");
  t.style.cssText = "width:100%;min-width:620px;border-collapse:collapse;";
  t.innerHTML = `
    <thead><tr>
      <th style="text-align:left;padding:8px;">Shop</th>
      <th style="text-align:right;padding:8px;">0–30</th>
      <th style="text-align:right;padding:8px;">31–60</th>
      <th style="text-align:right;padding:8px;">61–90</th>
      <th style="text-align:right;padding:8px;">90+</th>
      <th style="text-align:right;padding:8px;">Total</th>
    </tr></thead>`;
  const tb = document.createElement("tbody");
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.setAttribute("data-client", r.clientId || "");
    tr.innerHTML = `
      <td style="padding:8px;">
        <div style="font-weight:600;">${esc(r.shopName)}</div>
        <div style="font-size:11px;color:var(--text-tertiary);">${esc(String(r.orders))} order${r.orders === 1 ? "" : "s"}${r.phone ? " · " + esc(r.phone) : ""}</div>
      </td>
      <td style="padding:8px;text-align:right;">${r.b0 ? esc(money(r.b0, r.currency)) : "—"}</td>
      <td style="padding:8px;text-align:right;">${r.b31 ? esc(money(r.b31, r.currency)) : "—"}</td>
      <td style="padding:8px;text-align:right;">${r.b61 ? esc(money(r.b61, r.currency)) : "—"}</td>
      <td style="padding:8px;text-align:right;${r.b90 ? "color:var(--danger,#b42318);font-weight:700;" : ""}">${r.b90 ? esc(money(r.b90, r.currency)) : "—"}</td>
      <td style="padding:8px;text-align:right;font-weight:700;">${esc(money(r.outstanding, r.currency))}</td>`;
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  wrap.appendChild(t);
  outlet.appendChild(wrap);
}

// ================================================================== ONE ORDER
async function orderView(outlet, orderId) {
  const s = session();
  if (!s) { outlet.appendChild(emptyState({ icon: "🔒", title: "Please sign in", body: "This screen is for the finance desk." })); return; }

  const head = await financeOrderHead(s.staffId, orderId);
  if (!head) {
    outlet.appendChild(pageHeader("Order", ""));
    outlet.appendChild(emptyState({
      icon: "🔍",
      title: "That order is not on this desk",
      body: "It may not have been sent to finance yet. Nothing has been changed.",
    }));
    const b = document.createElement("a");
    b.className = "btn btn-secondary"; b.href = "#/finance"; b.textContent = "Back to finance";
    outlet.appendChild(b);
    return;
  }

  const cur = head.currency || "$";
  outlet.appendChild(pageHeader(
    `${head.reference} — ${head.shopName || head.buyerLabel || "—"}`,
    `Placed ${new Date(head.placedAt).toLocaleString()}`
  ));

  const back = document.createElement("a");
  back.className = "btn btn-ghost btn-sm no-print";
  back.href = "#/finance"; back.textContent = "← Finance";
  back.style.cssText = "margin-bottom:12px;min-height:44px;display:inline-flex;align-items:center;";
  outlet.appendChild(back);

  // ------------------------------------------------------------- the numbers
  const box = document.createElement("div");
  box.className = "card";
  box.style.cssText = "padding:14px;margin-bottom:12px;";
  box.setAttribute("data-testid", "finance-summary");

  // ⚠️ The margin sentence is built from how much of the order is actually
  // costed. Three shapes, and the difference between them is the difference
  // between a number and a guess.
  let marginHtml;
  if (!head.linesTotal || head.linesCosted === 0) {
    marginHtml = `<div style="font-size:13px;color:var(--text-tertiary);">
      No cost is recorded for anything on this order, so there is no margin to show.
      Add cost prices to the products to see it here.</div>`;
  } else if (head.linesCosted < head.linesTotal) {
    marginHtml = `
      <div style="font-size:18px;font-weight:700;">${esc(money(head.knownMargin || 0, cur))}</div>
      <div style="font-size:12px;color:var(--warning-700,#92400e);">
        ⚠️ margin on ${esc(String(head.linesCosted))} of ${esc(String(head.linesTotal))} lines —
        the rest have no cost recorded, so this is not the whole order
      </div>`;
  } else {
    const pct = head.subtotal ? Math.round(((head.knownMargin || 0) / head.subtotal) * 100) : 0;
    marginHtml = `
      <div style="font-size:18px;font-weight:700;">${esc(money(head.knownMargin || 0, cur))}</div>
      <div style="font-size:12px;color:var(--text-secondary);">margin · ${esc(String(pct))}% of the order</div>`;
  }

  box.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;">
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-tertiary);">Ordered</div>
        <div style="font-size:18px;font-weight:700;">${esc(money(head.subtotal, cur))}</div>
      </div>
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-tertiary);">Received</div>
        <div style="font-size:18px;font-weight:700;">${esc(money(head.received, cur))}</div>
      </div>
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-tertiary);">Outstanding</div>
        <div style="font-size:18px;font-weight:700;${head.outstanding > 0 ? "color:var(--danger,#b42318);" : ""}">${esc(money(head.outstanding, cur))}</div>
      </div>
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-tertiary);">Margin</div>
        ${marginHtml}
      </div>
    </div>
    ${head.phone || head.email ? `<div style="margin-top:10px;font-size:12px;color:var(--text-secondary);">
      ${head.phone ? esc(head.phone) : ""}${head.phone && head.email ? " · " : ""}${head.email ? esc(head.email) : ""}</div>` : ""}`;
  outlet.appendChild(box);

  if (head.orderNote) {
    const n = document.createElement("div");
    n.className = "card";
    n.style.cssText = "border-left:4px solid var(--info-500,#3b82f6);padding:10px 12px;margin-bottom:12px;";
    n.innerHTML = `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-tertiary);">The shop said</div>
                   <div style="font-size:14px;white-space:pre-wrap;">${esc(head.orderNote)}</div>`;
    outlet.appendChild(n);
  }

  // ---------------------------------------------------------------- the lines
  const lines = await financeOrderLines(s.staffId, orderId);
  const wrap = document.createElement("div");
  wrap.style.cssText = "overflow-x:auto;margin-bottom:14px;";
  const t = document.createElement("table");
  t.className = "table";
  t.setAttribute("data-testid", "finance-lines");
  t.style.cssText = "width:100%;min-width:600px;border-collapse:collapse;";
  t.innerHTML = `<thead><tr>
      <th style="text-align:left;padding:8px;">Item</th>
      <th style="text-align:right;padding:8px;">Qty</th>
      <th style="text-align:right;padding:8px;">Price</th>
      <th style="text-align:right;padding:8px;">Total</th>
      <th style="text-align:right;padding:8px;">Cost</th>
      <th style="text-align:right;padding:8px;">Margin</th>
    </tr></thead>`;
  const tb = document.createElement("tbody");
  lines.forEach((l) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="padding:8px;">
        <div style="font-weight:600;">${esc(l.productName)}</div>
        <div style="font-size:11px;color:var(--text-tertiary);">
          ${[l.colour, l.size, l.sku].filter(Boolean).map(esc).join(" · ")}</div>
      </td>
      <td style="padding:8px;text-align:right;">${esc(String(l.qty))}</td>
      <td style="padding:8px;text-align:right;">${esc(money(l.unitPrice, cur))}</td>
      <td style="padding:8px;text-align:right;">${esc(money(l.lineTotal, cur))}</td>
      <td style="padding:8px;text-align:right;color:var(--text-secondary);">${
        // ⚠️ An em dash, never 0.00. "We do not know what this cost" is a
        // different statement from "it was free", and only one of them is true.
        l.lineCost == null ? "—" : esc(money(l.lineCost, cur))}</td>
      <td style="padding:8px;text-align:right;${l.lineMargin != null && l.lineMargin < 0 ? "color:var(--danger,#b42318);font-weight:700;" : ""}">${
        l.lineMargin == null ? "—" : esc(money(l.lineMargin, cur))}</td>`;
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  wrap.appendChild(t);
  outlet.appendChild(wrap);

  // ------------------------------------------------------- money that arrived
  const receipts = await moneyReceivedFor(s.staffId, orderId);
  const rBox = document.createElement("div");
  rBox.className = "card";
  rBox.style.cssText = "padding:14px;margin-bottom:14px;";
  rBox.setAttribute("data-testid", "finance-receipts");
  rBox.innerHTML = `<div style="font-weight:600;margin-bottom:8px;">Money received</div>`;
  if (!receipts.length) {
    const p = document.createElement("div");
    p.style.cssText = "font-size:13px;color:var(--text-tertiary);";
    // Says plainly what this is and is not.
    p.textContent = "Nothing recorded yet. This is a record of money that arrived "
                  + "in the bank, in cash or by cheque — OGGI does not take payments.";
    rBox.appendChild(p);
  } else {
    receipts.forEach((r) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--border-default,#eee);flex-wrap:wrap;";
      row.innerHTML = `
        <strong>${esc(money(r.amount, r.currency))}</strong>
        <span style="font-size:12px;color:var(--text-secondary);">${esc(METHOD_LABEL[r.method] || r.method)}</span>
        <span style="font-size:12px;color:var(--text-tertiary);">${esc(new Date(r.receivedOn).toLocaleDateString())}</span>
        ${r.reference ? `<span style="font-size:12px;color:var(--text-tertiary);">ref ${esc(r.reference)}</span>` : ""}
        <span style="margin-left:auto;font-size:11px;color:var(--text-tertiary);">recorded by ${esc(r.recordedBy || "—")}</span>
        ${r.note ? `<div style="flex-basis:100%;font-size:12px;color:var(--text-secondary);white-space:pre-wrap;">${esc(r.note)}</div>` : ""}`;
      rBox.appendChild(row);
    });
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn btn-secondary";
  // The label is deliberate. Not "Take payment", not "Charge" -- this records
  // something that already happened somewhere else.
  add.textContent = "Record money received";
  add.style.cssText = "margin-top:10px;min-height:48px;";
  add.addEventListener("click", async () => {
    const amountStr = await ask({
      title: "Record money received",
      body: "Money that has already arrived — in the bank, in cash or by cheque. "
          + "OGGI does not take payments; this is your record of one.",
      label: `Amount (${cur})`,
      type: "number",
      confirmLabel: "Next",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return "Enter an amount above zero.";
        if (n > head.outstanding + 0.001) {
          // A warning, not a refusal: overpayment and credit on account are real.
          return null;
        }
        return null;
      },
    });
    if (amountStr == null) return;
    const method = await ask({
      title: "How did it arrive?",
      label: "Method",
      confirmLabel: "Record",
      choices: Object.entries(METHOD_LABEL).map(([value, label]) => ({ value, label })),
    });
    if (method == null) return;
    const reference = await ask({
      title: "Reference",
      body: "Transfer reference, cheque number, or leave blank.",
      label: "Reference (optional)",
      confirmLabel: "Save",
    });
    if (reference == null) return;

    const r = await recordMoneyReceived(s.staffId, orderId, {
      amount: Number(amountStr), method, reference,
    });
    if (!r.ok) { toast(r.error, { type: "error" }); return; }
    toast("Recorded");
    outlet.innerHTML = "";
    await orderView(outlet, orderId);
  });
  rBox.appendChild(add);
  outlet.appendChild(rBox);

  // ------------------------------------------------------------- the actions
  const actions = document.createElement("div");
  actions.className = "no-print";
  actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";

  if (head.state === "sent") {
    const accept = document.createElement("button");
    accept.type = "button"; accept.className = "btn btn-primary";
    accept.textContent = "I've got this"; accept.style.minHeight = "48px";
    accept.addEventListener("click", async () => {
      const r = await deskAccept(s.staffId, orderId, "finance");
      if (!r.ok) { toast(r.error, { type: "error" }); return; }
      toast("Marked as yours");
      outlet.innerHTML = "";
      await orderView(outlet, orderId);
    });
    actions.appendChild(accept);
  }

  if (head.state === "sent" || head.state === "accepted") {
    const done = document.createElement("button");
    done.type = "button"; done.className = "btn btn-primary";
    done.textContent = "Settled"; done.style.minHeight = "48px";
    done.addEventListener("click", async () => {
      const r = await deskComplete(s.staffId, orderId, "finance");
      if (!r.ok) { toast(r.error, { type: "error" }); return; }
      toast("Marked settled");
      location.hash = "#/finance";
    });
    actions.appendChild(done);

    const query = document.createElement("button");
    query.type = "button"; query.className = "btn btn-secondary";
    query.textContent = "Query with the office"; query.style.minHeight = "48px";
    query.addEventListener("click", async () => {
      const reason = await ask({
        title: "Query this order",
        body: "The office will see this straight away. Say what is wrong.",
        label: "What is wrong?",
        placeholder: "e.g. the discount does not match what was agreed",
        confirmLabel: "Send it back",
        validate: (v) => (String(v || "").trim().length < 3
          ? "Please say what is wrong — the office cannot fix what it cannot see."
          : null),
      });
      if (reason == null) return;
      const r = await deskReturn(s.staffId, orderId, "finance", reason);
      if (!r.ok) { toast(r.error, { type: "error" }); return; }
      toast("Sent back to the office");
      location.hash = "#/finance";
    });
    actions.appendChild(query);
  }

  const note = document.createElement("button");
  note.type = "button"; note.className = "btn btn-ghost";
  note.textContent = "Note for the office"; note.style.minHeight = "48px";
  note.addEventListener("click", async () => {
    const v = await ask({ title: "Note for the office", label: "Note", confirmLabel: "Send" });
    if (v == null) return;
    const r = await deskNote(s.staffId, orderId, "finance", v);
    toast(r.ok ? "Sent" : r.error, { type: r.ok ? "default" : "error" });
  });
  actions.appendChild(note);

  outlet.appendChild(actions);
}

export function registerFinanceRoutes(router) {
  router.register("/finance", (outlet) => queueView(outlet));
  router.register("/finance/aging", (outlet) => agingView(outlet));
  router.register("/finance/order/:id", (outlet, params) => orderView(outlet, params.id));
}
