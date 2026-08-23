// =============================================================================
// OGGI Wholesale v2 — RECEIVE STOCK DIALOG          (Batch 8A, 23 Aug 2026)
// =============================================================================
//
// WHAT IT REPLACES
// ----------------
// Four consecutive native `prompt()` boxes:
//
//   1. "Receive how many units of X (blue/M)?"
//   2. "Optional: freight cost for this receipt of N units? (Cancel to skip
//       landed-cost tracking)"
//   3. "Duty/customs cost for this receipt?"
//   4. "Any other landed cost (handling, inspection, etc.)?"
//
// WHY THAT WAS WORSE THAN IT LOOKED
// ---------------------------------
//  - CANCEL ON BOX 2 SILENTLY DISCARDED BOXES 3 AND 4. The only way to record
//    freight without duty was to type a 0 you did not mean. The opt-out was
//    welded to the first field.
//  - THE STOCK WAS ALREADY WRITTEN before box 2 appeared. Cancelling looked
//    like cancelling the receipt. It was not -- the units were in. Only the
//    cost detail was lost, and nothing on screen said so.
//  - `parseInt(prompt(...))` on Cancel gives NaN, on "abc" gives NaN, and on
//    "10 boxes" gives 10. Three very different mistakes, one silent outcome.
//  - A native prompt cannot be styled, cannot be tested by any gate, freezes
//    the page thread while it is open, and on a phone it is a grey system
//    sheet that looks like the browser asking, not the app.
//
// WHAT THIS DOES INSTEAD
// ----------------------
// One form. Quantity is required and validated before anything is written.
// Landed cost is an optional disclosure the person opens if they have the
// numbers, and each of the three fields stands alone. Nothing is written to
// the database until Confirm, so Cancel means cancel.
//
// It also shows the resulting on-hand figure live, because "receive 10" and
// "set to 10" is the single most common confusion in stock software, and the
// cheapest way to settle it is to show the arithmetic while they type.
// =============================================================================

import { esc } from "../lib/utils.js";
import { openModal, closeModal } from "../lib/modal-stack.js";

/**
 * @param {object}   row                The stock row being received into.
 * @param {string}   row.productName
 * @param {string}   [row.color]
 * @param {string}   [row.size]
 * @param {string}   row.sku
 * @param {string}   row.locationName
 * @param {number}   row.onHand
 * @param {number}   [row.cost]         Unit cost, for the landed-cost maths.
 * @param {Function} onConfirm          async ({ qty, freight, duty, other,
 *                                       recordCost }) => { ok, error? }
 *                                      The caller owns the database writes, so
 *                                      this component imports nothing from
 *                                      js/data and can be exercised in a gate.
 */
export function openReceiveDialog(row, onConfirm) {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.setAttribute("role", "dialog");
  back.setAttribute("aria-modal", "true");

  const box = document.createElement("div");
  box.className = "card modal-box";

  const variant = [row.color, row.size].filter(Boolean).join(" / ") || "—";

  box.innerHTML = `
    <div class="modal-title">Receive stock</div>
    <div class="modal-sub">
      ${esc(row.productName)} · ${esc(variant)}<br>
      SKU ${esc(row.sku)} · into ${esc(row.locationName || "your warehouse")}
    </div>

    <label class="modal-label" for="rcv-qty">How many units are you receiving?</label>
    <input class="input" id="rcv-qty" type="number" min="1" step="1" inputmode="numeric"
           value="10" autocomplete="off">
    <div class="modal-hint" id="rcv-maths"></div>
    <div class="modal-err" id="rcv-err" role="alert"></div>

    <details class="modal-details" id="rcv-cost">
      <summary>Add landed cost for this receipt (optional)</summary>
      <div class="modal-hint" style="margin-bottom:8px;">
        Freight, duty and handling for this shipment. Leave this closed if you
        do not have the figures — the stock still goes in either way.
      </div>
      <div class="pf-grid">
        <div class="pf-field">
          <label class="modal-label" for="rcv-freight">Freight</label>
          <input class="input" id="rcv-freight" type="number" min="0" step="0.01" inputmode="decimal" value="0">
        </div>
        <div class="pf-field">
          <label class="modal-label" for="rcv-duty">Duty / customs</label>
          <input class="input" id="rcv-duty" type="number" min="0" step="0.01" inputmode="decimal" value="0">
        </div>
        <div class="pf-field">
          <label class="modal-label" for="rcv-other">Other (handling, inspection)</label>
          <input class="input" id="rcv-other" type="number" min="0" step="0.01" inputmode="decimal" value="0">
        </div>
      </div>
      <div class="modal-hint" id="rcv-landed"></div>
    </details>

    <div class="modal-actions">
      <button class="btn btn-ghost" data-a="cancel" type="button">Cancel</button>
      <button class="btn btn-primary" data-a="confirm" type="button">Receive stock</button>
    </div>
  `;

  back.appendChild(box);

  const qtyEl     = box.querySelector("#rcv-qty");
  const errEl     = box.querySelector("#rcv-err");
  const mathsEl   = box.querySelector("#rcv-maths");
  const landedEl  = box.querySelector("#rcv-landed");
  const costEl    = box.querySelector("#rcv-cost");
  const confirmEl = box.querySelector('[data-a="confirm"]');

  const num = (el) => {
    const v = parseFloat(el.value);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };

  /** The arithmetic, shown live. "Receive 10" vs "set to 10" is the commonest
   *  misunderstanding in stock software; showing the result removes the doubt
   *  instead of documenting it. */
  function paintMaths() {
    const q = parseInt(qtyEl.value, 10);
    if (!Number.isFinite(q) || q <= 0) { mathsEl.textContent = ""; return; }
    mathsEl.textContent = `${row.onHand} on hand now → ${row.onHand + q} after this receipt.`;
  }

  function paintLanded() {
    const q = parseInt(qtyEl.value, 10);
    const extra = num(box.querySelector("#rcv-freight")) + num(box.querySelector("#rcv-duty")) + num(box.querySelector("#rcv-other"));
    if (!Number.isFinite(q) || q <= 0 || extra <= 0) { landedEl.textContent = ""; return; }
    const base = Number(row.cost) || 0;
    const perUnit = base + extra / q;
    landedEl.textContent = `Landed cost ≈ ${perUnit.toFixed(2)} per unit (${base.toFixed(2)} unit cost + ${(extra / q).toFixed(2)} spread over ${q} units).`;
  }

  qtyEl.addEventListener("input", () => { errEl.textContent = ""; paintMaths(); paintLanded(); });
  ["#rcv-freight", "#rcv-duty", "#rcv-other"].forEach((sel) => {
    box.querySelector(sel).addEventListener("input", paintLanded);
  });
  paintMaths();

  const close = () => closeModal(back);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  box.querySelector('[data-a="cancel"]').addEventListener("click", close);

  confirmEl.addEventListener("click", async () => {
    const qty = parseInt(qtyEl.value, 10);
    // Validated BEFORE anything is written, which is the whole difference
    // from the prompt version: there, the stock was already in the database
    // by the time the second question was asked.
    if (!Number.isFinite(qty) || qty <= 0) {
      errEl.textContent = "Enter how many units you are receiving — a whole number, 1 or more.";
      qtyEl.focus();
      return;
    }
    confirmEl.disabled = true;
    confirmEl.textContent = "Receiving…";

    const recordCost = costEl.open;
    const res = await onConfirm({
      qty,
      freight: recordCost ? num(box.querySelector("#rcv-freight")) : 0,
      duty:    recordCost ? num(box.querySelector("#rcv-duty"))    : 0,
      other:   recordCost ? num(box.querySelector("#rcv-other"))   : 0,
      recordCost,
    });

    if (res && res.ok === false) {
      // Stays open on failure with the numbers still in it. A dialog that
      // closes on error makes the person retype everything to find out
      // whether it was their input or the network.
      errEl.textContent = res.error || "That receipt could not be saved. Nothing was changed.";
      confirmEl.disabled = false;
      confirmEl.textContent = "Receive stock";
      return;
    }
    close();
  });

  openModal(back, { label: `Receive stock — ${row.productName}` });
  qtyEl.focus();
  qtyEl.select();
  return { close };
}
