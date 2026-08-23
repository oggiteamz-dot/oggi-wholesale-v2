// OGGI Wholesale v2 — subscription controls for one wholesaler (CR-0002)
//
// Renders the billing strip on a wholesaler's row: where their
// subscription stands, the stacking extend buttons, the price, and the
// two different ways to stop a subscription.
//
// THREE DELIBERATE DESIGN CHOICES -- please don't "tidy" these away:
//
// 1. EXTEND BUTTONS DON'T ASK FOR CONFIRMATION. Adding paid time is
//    harmless and reversible (extend again, or terminate). Making the
//    common, safe action fast is the point.
//
// 2. CANCEL AND TERMINATE LOOK DIFFERENT AND SIT APART. Cancel is quiet
//    and leaves the customer the time they already paid for. Terminate is
//    red, asks for typed confirmation, and cuts access off today. They do
//    genuinely different things, so they must never look like the same
//    button in a hurry.
//
// 3. THE STATUS SENTENCE COMES FROM THE DATABASE (status_label on the
//    v2_wholesaler_billing view), not from date maths done here. One
//    definition of "are they paid up", shared by every screen.

import { toast } from "./toast.js";
import { extendSubscription, cancelSubscription, setPrice } from "../data/subscriptions.js";
import { esc } from "../lib/utils.js";
import { ask } from "./ask.js";

// Months, not "periods" — so any combination stacks correctly.
const EXTEND_OPTIONS = [
  { label: "+ 1 month",   months: 1  },
  { label: "+ 6 months",  months: 6  },
  { label: "+ 1 year",    months: 12 },
];

/**
 * @param {object}   opts
 * @param {string}   opts.wid
 * @param {object}   opts.billing   a row from v2_wholesaler_billing
 * @param {Function} opts.onChange  called after any successful change so
 *                                  the caller can re-render from the
 *                                  database rather than guessing locally
 */
export function renderSubscriptionPanel({ wid, billing = {}, onChange = () => {} }) {
  const el = document.createElement("div");
  el.style.cssText =
    "margin-top:12px;padding-top:12px;border-top:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:10px;";

  const paidUp = !!billing.is_paid_up;
  const days = billing.days_remaining;
  // Amber inside a week: the useful signal is "about to lapse", which a
  // plain green/red split would hide until the day it breaks.
  const tone = !paidUp ? "var(--danger)" : (days !== null && days <= 7) ? "var(--warning, #b26b00)" : "var(--success)";

  // ---- status line -------------------------------------------------
  const status = document.createElement("div");
  status.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
  status.innerHTML = `
    <span style="font-size:12px;font-weight:650;color:${tone};">
      ${esc(billing.status_label || "Never subscribed")}
    </span>
    ${billing.price_amount != null
      ? `<span style="font-size:12px;color:var(--text-tertiary);">
           ${esc(billing.price_currency || "$")}${Number(billing.price_amount).toFixed(2)} / ${esc(billing.billing_period || "monthly")}
         </span>`
      : `<span style="font-size:12px;color:var(--text-tertiary);">no price set</span>`}
  `;
  el.appendChild(status);

  // ---- extend (stacking) -------------------------------------------
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;align-items:center;";

  EXTEND_OPTIONS.forEach((opt) => {
    const b = document.createElement("button");
    b.className = "btn btn-secondary btn-sm";
    b.textContent = opt.label;
    b.title = paidUp
      ? "Adds on top of their current end date"
      : "Starts from today";
    b.addEventListener("click", async () => {
      b.disabled = true;
      const prev = b.textContent;
      b.textContent = "…";
      // Amount defaults to their agreed price so the money trail is
      // populated without extra typing; null if no price is set yet.
      const res = await extendSubscription(wid, opt.months, billing.price_amount ?? null, null);
      b.disabled = false;
      b.textContent = prev;
      if (!res.ok) { toast(res.error || "Could not extend", { type: "danger" }); return; }
      toast(`Extended — now paid until ${res.paidUntil}`, { type: "success" });
      onChange();
    });
    row.appendChild(b);
  });

  // ---- price -------------------------------------------------------
  const priceInput = document.createElement("input");
  priceInput.className = "input";
  priceInput.type = "number";
  priceInput.min = "0";
  priceInput.step = "0.01";
  priceInput.placeholder = "price";
  priceInput.style.cssText = "width:90px;margin-left:8px;";
  if (billing.price_amount != null) priceInput.value = billing.price_amount;

  const periodSelect = document.createElement("select");
  periodSelect.className = "input";
  periodSelect.style.width = "auto";
  [["monthly", "per month"], ["biannual", "per 6 months"], ["yearly", "per year"]]
    .forEach(([v, l]) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = l;
      if (billing.billing_period === v) o.selected = true;
      periodSelect.appendChild(o);
    });

  const savePrice = document.createElement("button");
  savePrice.className = "btn btn-ghost btn-sm";
  savePrice.textContent = "Save price";
  savePrice.addEventListener("click", async () => {
    const amount = parseFloat(priceInput.value);
    if (isNaN(amount)) { toast("Enter a price first", { type: "danger" }); return; }
    savePrice.disabled = true;
    const res = await setPrice(wid, amount, billing.price_currency || "$", periodSelect.value);
    savePrice.disabled = false;
    if (!res.ok) { toast(res.error || "Could not save the price", { type: "danger" }); return; }
    toast("Price saved", { type: "success" });
    onChange();
  });

  row.append(priceInput, periodSelect, savePrice);
  el.appendChild(row);

  // ---- stopping a subscription -------------------------------------
  const stopRow = document.createElement("div");
  stopRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;align-items:center;";

  // CANCEL — the normal one. They keep what they paid for.
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn-ghost btn-sm";
  cancelBtn.textContent = "Cancel subscription";
  cancelBtn.title = "Stops renewing. They keep access until their paid time runs out.";
  cancelBtn.addEventListener("click", async () => {
    const reason = await ask({
      title: `Cancel ${billing.brand || wid}'s subscription?`,
      body: `They KEEP access until ${billing.paid_until || "their paid time ends"}. Nothing is cut off today.`,
      label: "Reason (recorded in the billing history)",
      placeholder: "e.g. moving to annual, closing the account",
      confirmLabel: "Cancel subscription",
      validate: (v) => (v.trim().length >= 3 ? null : "Give a short reason — it is the only record of why this account stopped renewing."),
    });
    if (reason === null) return;
    const res = await cancelSubscription(wid, reason, false);
    if (!res.ok) { toast(res.error || "Could not cancel", { type: "danger" }); return; }
    toast("Subscription cancelled — access kept until their paid date", { type: "default" });
    onChange();
  });

  // TERMINATE — the destructive one. Typed confirmation, because a
  // mis-click here cuts off a paying customer's business today.
  const killBtn = document.createElement("button");
  killBtn.className = "btn btn-sm";
  killBtn.textContent = "Terminate now";
  killBtn.style.cssText = "color:var(--danger);border:1px solid var(--danger);background:transparent;";
  killBtn.title = "Ends their access TODAY, even if they have paid time left.";
  killBtn.addEventListener("click", async () => {
    // The typed confirmation stays -- it is the right control for an action
    // that cuts off a paying customer's business today. What changes is that
    // the dialog now REFUSES a wrong word instead of accepting it, closing,
    // and only then telling you via a toast that nothing happened.
    const typed = await ask({
      title: `Terminate ${billing.brand || wid} immediately?`,
      body: `This ends their access TODAY${billing.paid_until ? `, discarding paid time up to ${billing.paid_until}` : ""}.`,
      label: "Type the word TERMINATE to confirm",
      placeholder: "TERMINATE",
      confirmLabel: "Terminate now",
      validate: (v) => (v.trim().toUpperCase() === "TERMINATE" ? null : "Type TERMINATE exactly to confirm, or Cancel to leave the account running."),
    });
    if (typed === null) return;
    const res = await cancelSubscription(wid, "Terminated by owner", true);
    if (!res.ok) { toast(res.error || "Could not terminate", { type: "danger" }); return; }
    toast("Access terminated today", { type: "danger" });
    onChange();
  });

  stopRow.append(cancelBtn, killBtn);
  el.appendChild(stopRow);

  return el;
}
