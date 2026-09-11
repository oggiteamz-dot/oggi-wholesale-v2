// =============================================================================
// OGGI Wholesale v2 — THE WAREHOUSE DESK                       Block 7, 11 Sep 2026
// =============================================================================
// Hadi, 11 Sep 2026: "any order that comes in, the owner could automatically
// send it to the warehouse manager."
//
// ==== ⭐ THERE IS NO MONEY ON THIS SCREEN, AND NOT BECAUSE IT IS HIDDEN =====
//
// The functions this view calls (migration 135) have no price, total or cost in
// their return tables AT ALL. There is nothing on the wire to hide. So there is
// no `money()` import in this file, no currency symbol, and no line that could
// be uncommented later to show one.
//
// Why it matters, plainly: a picker does not need a price to pick, and a price
// on a pick sheet is a price on the warehouse floor -- on a tablet that lies on
// a bench all day, readable by every casual worker and every driver from another
// company waiting for a collection. checks/check_warehouse_sees_no_money.mjs
// asserts it of the rendered DOM as well as of the SQL, because "we did not put
// it on the screen" is a habit and "it is not in the signature" is a fact.
//
// ==== ⭐ AND fulfil_note IS FINALLY READABLE ================================
//
// Migration 087 created that column on 28 August, quoting Hadi asking for a way
// to tell "the people what to do". It has never been read by anybody, anywhere,
// because there has been no warehouse account in this product. Every order
// written since then has carried an instruction to a department that could not
// open it. It is the first thing on this screen.
// =============================================================================

import { esc, pageHeader } from "../lib/utils.js";
import { emptyState } from "../components/empty-state.js";
import { toast } from "../components/toast.js";
import { ask, confirmAction } from "../components/ask.js";
import {
  warehouseQueue, warehouseOrderHead, warehouseOrderLines,
  pickLine, deskAccept, deskComplete, deskReturn, deskNote,
} from "../data/desk.js";
import { readDeskSession } from "../data/staff-auth.js";

const STATE_LABEL = {
  sent: "Waiting", accepted: "In progress", done: "Done", returned: "Handed back",
};
const STATE_BADGE = {
  sent: "badge-info", accepted: "badge-warning", done: "badge-success", returned: "badge-danger",
};

function session() { return readDeskSession(); }

function ago(iso) {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** A note, shown as a note rather than as a paragraph of body text. Used for
 *  both authors, with the AUTHOR NAMED -- migration 087's whole point is that
 *  two different people write two different notes and a picker must never have
 *  to guess which one they are reading. */
function noteBlock(who, text, accent) {
  const el = document.createElement("div");
  el.className = "card";
  el.setAttribute("data-note-from", who === "The office" ? "office" : "buyer");
  el.style.cssText = `border-left:4px solid ${accent};padding:10px 12px;margin:8px 0;`;
  el.innerHTML = `
    <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;
                color:var(--text-tertiary);margin-bottom:4px;">${esc(who)}</div>
    <div style="font-size:14px;line-height:1.45;white-space:pre-wrap;">${esc(text)}</div>`;
  return el;
}

// =================================================================== THE QUEUE
async function queueView(outlet) {
  const s = session();
  if (!s) { outlet.appendChild(emptyState({ icon: "🔒", title: "Please sign in", body: "This screen is for warehouse staff." })); return; }

  outlet.appendChild(pageHeader(
    "Picking",
    `${esc(s.wholesalerName || s.wid)} — oldest orders first`
  ));

  const rows = await warehouseQueue(s.staffId);

  // A count strip, because the first question at a desk is "how much is there".
  const waiting  = rows.filter((r) => r.state === "sent").length;
  const running  = rows.filter((r) => r.state === "accepted").length;
  const units    = rows.reduce((a, r) => a + r.unitCount, 0);
  const picked   = rows.reduce((a, r) => a + r.pickedCount, 0);

  const strip = document.createElement("div");
  strip.className = "stat-grid";
  [["Waiting", waiting], ["In progress", running], ["Pieces to pick", Math.max(0, units - picked)]]
    .forEach(([label, value]) => {
      const c = document.createElement("div");
      c.className = "card stat-card";
      c.innerHTML = `<div class="stat-value">${esc(String(value))}</div>
                     <div class="stat-label">${esc(label)}</div>`;
      strip.appendChild(c);
    });
  outlet.appendChild(strip);

  if (!rows.length) {
    outlet.appendChild(emptyState({
      icon: "📦",
      title: "Nothing waiting",
      // Honest about WHY it might be empty. A picker staring at a blank screen
      // needs to know whether there is no work or whether nobody is sending it.
      body: "When the office sends an order to the warehouse it appears here. "
          + "If you are expecting one and it has not arrived, ask them to send it.",
    }));
    return;
  }

  const list = document.createElement("div");
  list.className = "card-list";
  list.setAttribute("data-testid", "warehouse-queue");

  rows.forEach((r) => {
    const a = document.createElement("a");
    a.className = "card";
    a.href = `#/warehouse/order/${encodeURIComponent(r.orderId)}`;
    a.setAttribute("data-order-id", r.orderId);
    // 48px floor: check_touch_targets.mjs, and a glove on a cold morning.
    a.style.cssText = "display:block;padding:14px;margin-bottom:10px;min-height:64px;text-decoration:none;color:inherit;";

    const done = r.unitCount ? Math.round((r.pickedCount / r.unitCount) * 100) : 0;

    a.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
        <strong style="font-size:15px;letter-spacing:.02em;">${esc(r.reference)}</strong>
        <span class="badge ${esc(STATE_BADGE[r.state] || "badge-info")}">${esc(STATE_LABEL[r.state] || r.state)}</span>
        <span style="margin-left:auto;font-size:12px;color:var(--text-tertiary);">${esc(ago(r.sentAt))}</span>
      </div>
      <div style="margin-top:4px;font-size:14px;">${esc(r.buyerLabel || "—")}</div>
      <div style="margin-top:6px;font-size:12px;color:var(--text-secondary);">
        ${esc(String(r.lineCount))} line${r.lineCount === 1 ? "" : "s"} ·
        ${esc(String(r.unitCount))} piece${r.unitCount === 1 ? "" : "s"}
        ${r.locationName ? ` · ${esc(r.locationName)}` : ""}
      </div>
      ${r.hasFulfilNote || r.hasBuyerNote ? `
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          ${r.hasFulfilNote ? `<span class="badge badge-accent" data-has="fulfil">Note from the office</span>` : ""}
          ${r.hasBuyerNote ? `<span class="badge badge-info" data-has="buyer">Note from the shop</span>` : ""}
        </div>` : ""}
      ${r.pickedCount > 0 ? `
        <div style="margin-top:8px;height:6px;border-radius:999px;background:var(--surface-2,#eee);overflow:hidden;">
          <div style="width:${esc(String(Math.min(100, done)))}%;height:100%;background:var(--accent-500);"></div>
        </div>
        <div style="margin-top:4px;font-size:11px;color:var(--text-tertiary);">
          ${esc(String(r.pickedCount))} of ${esc(String(r.unitCount))} picked
        </div>` : ""}
    `;
    list.appendChild(a);
  });

  outlet.appendChild(list);
}

// =============================================================== ONE ORDER
async function orderView(outlet, orderId) {
  const s = session();
  if (!s) { outlet.appendChild(emptyState({ icon: "🔒", title: "Please sign in", body: "This screen is for warehouse staff." })); return; }

  const head = await warehouseOrderHead(s.staffId, orderId);
  if (!head) {
    outlet.appendChild(pageHeader("Order", ""));
    outlet.appendChild(emptyState({
      icon: "🔍",
      title: "That order is not on this desk",
      // Deliberately one message for "never sent here", "belongs to another
      // store" and "does not exist". 088's rule: a dead link and a fake link
      // answer identically.
      body: "It may not have been sent to the warehouse yet. Nothing has been changed.",
    }));
    const back = document.createElement("a");
    back.className = "btn btn-secondary";
    back.href = "#/warehouse";
    back.textContent = "Back to picking";
    outlet.appendChild(back);
    return;
  }

  outlet.appendChild(pageHeader(
    `${head.reference} — ${head.buyerLabel || "—"}`,
    `${head.locationName ? esc(head.locationName) + " · " : ""}placed ${new Date(head.placedAt).toLocaleString()}`
  ));

  const back = document.createElement("a");
  back.className = "btn btn-ghost btn-sm no-print";
  back.href = "#/warehouse";
  back.textContent = "← Picking";
  back.style.cssText = "margin-bottom:12px;min-height:44px;display:inline-flex;align-items:center;";
  outlet.appendChild(back);

  const badge = document.createElement("div");
  badge.innerHTML = `<span class="badge ${esc(STATE_BADGE[head.state] || "badge-info")}">${esc(STATE_LABEL[head.state] || head.state)}</span>`;
  badge.style.marginBottom = "8px";
  outlet.appendChild(badge);

  if (head.state === "returned" && head.returnReason) {
    outlet.appendChild(noteBlock("Handed back — you said", head.returnReason, "var(--danger,#b42318)"));
  }

  // ⭐ THE OFFICE'S INSTRUCTION, FIRST. Migration 087, 28 August, unread until
  // this line existed.
  if (head.fulfilNote) {
    outlet.appendChild(noteBlock("The office", head.fulfilNote, "var(--accent-500)"));
  }
  // And the shop's own words, kept visibly separate. Two authors, two blocks,
  // never one merged paragraph.
  if (head.orderNote) {
    outlet.appendChild(noteBlock("The shop", head.orderNote, "var(--info-500,#3b82f6)"));
  }

  const lines = await warehouseOrderLines(s.staffId, orderId);
  if (!lines.length) {
    outlet.appendChild(emptyState({ icon: "📭", title: "No lines on this order", body: "Nothing to pick." }));
    return;
  }

  // Packs are shown AS PACKS and ALSO exploded into pickable pieces (manifest
  // rows 136/170): a picker fetching a sealed prepack wants to know it is one
  // box; a picker checking it wants the pieces.
  const packs = new Map();
  lines.forEach((l) => { if (l.packId) packs.set(l.packId, (packs.get(l.packId) || 0) + 1); });
  if (packs.size) {
    const p = document.createElement("div");
    p.className = "card";
    p.style.cssText = "padding:10px 12px;margin:8px 0;";
    p.innerHTML = `<div style="font-size:12px;color:var(--text-secondary);">
      ${esc(String(packs.size))} pre-pack${packs.size === 1 ? "" : "s"} on this order —
      the pieces are listed individually below so they can be checked.</div>`;
    outlet.appendChild(p);
  }

  const list = document.createElement("div");
  list.setAttribute("data-testid", "warehouse-lines");
  outlet.appendChild(list);

  let total = 0, got = 0;
  const progress = document.createElement("div");
  progress.style.cssText = "position:sticky;bottom:0;background:var(--surface,#fff);padding:10px 0;";
  const repaintProgress = () => {
    progress.innerHTML = `
      <div style="height:8px;border-radius:999px;background:var(--surface-2,#eee);overflow:hidden;">
        <div style="width:${esc(String(total ? Math.round((got/total)*100) : 0))}%;height:100%;background:var(--accent-500);transition:width .2s;"></div>
      </div>
      <div style="margin-top:6px;font-size:13px;text-align:center;">
        <strong>${esc(String(got))}</strong> of <strong>${esc(String(total))}</strong> pieces picked
      </div>`;
  };

  lines.forEach((l) => {
    total += l.qty; got += l.pickedQty;

    const row = document.createElement("div");
    row.className = "card";
    row.setAttribute("data-line-id", String(l.orderItemId));
    row.style.cssText = "display:flex;gap:12px;padding:12px;margin-bottom:10px;align-items:flex-start;";

    const thumb = document.createElement("div");
    thumb.style.cssText = "width:56px;height:56px;flex:none;border-radius:8px;overflow:hidden;background:var(--surface-2,#f2f2f2);";
    if (l.imageUrl) {
      const img = document.createElement("img");
      img.src = l.imageUrl; img.alt = ""; img.loading = "lazy";
      img.style.cssText = "width:100%;height:100%;object-fit:cover;";
      thumb.appendChild(img);
    }
    row.appendChild(thumb);

    const body = document.createElement("div");
    body.style.cssText = "flex:1;min-width:0;";
    body.innerHTML = `
      <div style="font-size:14px;font-weight:600;">${esc(l.productName)}</div>
      <div style="margin-top:3px;font-size:12px;color:var(--text-secondary);display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        ${l.colourHex ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--border-default,#ddd);background:${esc(l.colourHex)};"></span>` : ""}
        ${l.colour ? `<span>${esc(l.colour)}</span>` : ""}
        ${l.size ? `<span>Size ${esc(l.size)}</span>` : ""}
        ${l.sku ? `<span style="color:var(--text-tertiary);">${esc(l.sku)}</span>` : ""}
      </div>
      <div style="margin-top:5px;font-size:12px;color:${l.qtyOnHand < l.qty ? "var(--danger,#b42318)" : "var(--text-tertiary)"};">
        ${esc(String(l.qtyOnHand))} in stock here${l.qtyOnHand < l.qty ? " — short" : ""}
      </div>
      ${l.fulfilNote ? `<div style="margin-top:6px;font-size:12px;border-left:3px solid var(--accent-500);padding-left:8px;white-space:pre-wrap;"><strong>Office:</strong> ${esc(l.fulfilNote)}</div>` : ""}
      ${l.buyerNote ? `<div style="margin-top:6px;font-size:12px;border-left:3px solid var(--info-500,#3b82f6);padding-left:8px;white-space:pre-wrap;"><strong>Shop:</strong> ${esc(l.buyerNote)}</div>` : ""}
    `;
    row.appendChild(body);

    // The stepper. Big targets on purpose -- this is used standing up, one
    // handed, often with a box in the other hand.
    const ctl = document.createElement("div");
    ctl.style.cssText = "flex:none;display:flex;flex-direction:column;align-items:center;gap:6px;";
    const count = document.createElement("div");
    count.setAttribute("data-picked", "");
    count.style.cssText = "font-size:15px;font-weight:700;min-width:58px;text-align:center;";
    const paintCount = () => { count.textContent = `${l.pickedQty}/${l.qty}`; };
    paintCount();

    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:6px;";
    const mk = (label, delta, aria) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-secondary";
      b.textContent = label;
      b.setAttribute("aria-label", aria);
      b.style.cssText = "min-width:48px;min-height:48px;font-size:18px;padding:0;";
      b.addEventListener("click", async () => {
        const next = Math.max(0, Math.min(l.qty, l.pickedQty + delta));
        if (next === l.pickedQty) return;
        b.disabled = true;
        const r = await pickLine(s.staffId, orderId, l.orderItemId, next);
        b.disabled = false;
        if (!r.ok) { toast(r.error, { type: "error" }); return; }
        got += (r.pickedQty - l.pickedQty);
        l.pickedQty = r.pickedQty;
        paintCount(); repaintProgress();
      });
      return b;
    };
    btns.appendChild(mk("−", -1, `One fewer of ${l.productName}`));
    btns.appendChild(mk("+", +1, `One more of ${l.productName}`));

    const all = document.createElement("button");
    all.type = "button";
    all.className = "btn btn-ghost btn-sm";
    all.textContent = "All";
    all.style.cssText = "min-height:36px;font-size:12px;";
    all.addEventListener("click", async () => {
      const r = await pickLine(s.staffId, orderId, l.orderItemId, l.qty);
      if (!r.ok) { toast(r.error, { type: "error" }); return; }
      got += (r.pickedQty - l.pickedQty);
      l.pickedQty = r.pickedQty;
      paintCount(); repaintProgress();
    });

    ctl.append(count, btns, all);
    row.appendChild(ctl);
    list.appendChild(row);
  });

  repaintProgress();
  outlet.appendChild(progress);

  // ------------------------------------------------------------- the actions
  const actions = document.createElement("div");
  actions.className = "no-print";
  actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;";

  if (head.state === "sent") {
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn btn-primary";
    accept.textContent = "I've got this";
    accept.style.minHeight = "48px";
    accept.addEventListener("click", async () => {
      accept.disabled = true;
      const r = await deskAccept(s.staffId, orderId, "warehouse");
      if (!r.ok) { accept.disabled = false; toast(r.error, { type: "error" }); return; }
      toast("Marked as yours");
      // Re-render in place rather than faking a hashchange. The hash has not
      // actually changed, and synthesising a navigation event to redraw a
      // screen is the kind of thing that works until something else listens.
      outlet.innerHTML = "";
      await orderView(outlet, orderId);
    });
    actions.appendChild(accept);
  }

  if (head.state === "sent" || head.state === "accepted") {
    const done = document.createElement("button");
    done.type = "button";
    done.className = "btn btn-primary";
    done.textContent = "Picked and packed";
    done.style.minHeight = "48px";
    done.addEventListener("click", async () => {
      // Finishing with pieces outstanding is allowed -- sometimes the rest is
      // genuinely not coming -- but it must be deliberate, because the office
      // reads "done" as "all of it".
      if (got < total) {
        const ok = await confirmAction({
          title: "Finish with pieces missing?",
          body: `${got} of ${total} pieces are picked. The office will see this order as done.\n\n`
              + `If pieces are missing, hand it back instead so they know why.`,
          confirmLabel: "Yes, it's finished",
          danger: true,
        });
        if (!ok) return;
      }
      const r = await deskComplete(s.staffId, orderId, "warehouse");
      if (!r.ok) { toast(r.error, { type: "error" }); return; }
      toast("Done — the office can see it");
      location.hash = "#/warehouse";
    });
    actions.appendChild(done);

    const handBack = document.createElement("button");
    handBack.type = "button";
    handBack.className = "btn btn-secondary";
    handBack.textContent = "Hand back";
    handBack.style.minHeight = "48px";
    handBack.addEventListener("click", async () => {
      const reason = await ask({
        title: "Hand this order back",
        body: "The office will see this straight away. Say what is wrong so they can fix it.",
        label: "What is wrong?",
        placeholder: "e.g. four short on the blue medium",
        confirmLabel: "Hand back",
        // Required here as well as in the database (134/138). The database stops
        // a bad row; this stops a person being handed a database error when
        // what they needed was to be asked for a sentence.
        validate: (v) => (String(v || "").trim().length < 3
          ? "Please say what is wrong — the office cannot fix what it cannot see."
          : null),
      });
      if (reason == null) return;
      const r = await deskReturn(s.staffId, orderId, "warehouse", reason);
      if (!r.ok) { toast(r.error, { type: "error" }); return; }
      toast("Handed back to the office");
      location.hash = "#/warehouse";
    });
    actions.appendChild(handBack);
  }

  const note = document.createElement("button");
  note.type = "button";
  note.className = "btn btn-ghost";
  note.textContent = "Note for the office";
  note.style.minHeight = "48px";
  note.addEventListener("click", async () => {
    const v = await ask({
      title: "Note for the office",
      body: "Anything they should know. This does not reach the shop.",
      label: "Note",
      confirmLabel: "Send",
    });
    if (v == null) return;
    const r = await deskNote(s.staffId, orderId, "warehouse", v);
    toast(r.ok ? "Sent" : r.error, { type: r.ok ? "default" : "error" });
  });
  actions.appendChild(note);

  outlet.appendChild(actions);
}

export function registerWarehouseRoutes(router) {
  router.register("/warehouse", (outlet) => queueView(outlet));
  router.register("/warehouse/order/:id", (outlet, params) => orderView(outlet, params.id));
}
