// =============================================================================
// OGGI Wholesale v2 — HOW DO BUYERS ORDER THIS?        (CR-0001, 24 Aug 2026)
// =============================================================================
//
// WHAT THIS REPLACES
// ------------------
// Two separate builders that were stacked in one drawer:
//
//   1. "Sell by ratio"  — a base-unit box, a saved-ratio LIBRARY, a mandatory
//      name field, a row of steppers, four starter buttons, and a save button.
//   2. "New pack"       — a pack name, a colour, a "flat price (not charged)"
//      box, a "suggest from sell-through" button, and then ONE ROW PER
//      VARIANT. On an 8-colour × 8-size product that is 64 rows.
//
// Roughly fifteen controls before the 64 rows even began, using nine different
// words -- ratio, curve, base unit, prepack, pack, component, multiplier, flat
// price, sell-through -- for what turned out to be one idea.
//
// Hadi, 24 Aug 2026: "It's too complicated... even I misunderstood and didn't
// know how to do most of the stuff you did in the ratio."
//
// He also proposed the fix: "if you want merge the ratio and prepack and series
// into a prepack only and give the wholesaler the ability to choose."
//
// WHY THAT MERGE IS CORRECT AND NOT A COMPROMISE
// ----------------------------------------------
// Because the database already treats them as one thing. This is the live
// v2_enforce_selling_model (migration 063), in full, for the three models:
//
//     series  -> order line must belong to a pack, else reject
//     prepack -> order line must belong to a pack, else reject
//     ratio   -> order line must belong to a pack, else reject
//
// Three names. One rule: you must order a box, not loose pieces. The only
// thing that differed between them was the wording of the error message and
// how the box got built. The wholesaler was being made to learn a three-way
// distinction the system does not make.
//
// The Aug-20 research said this in as many words -- "Open stock, series,
// prepack and ratio are NOT four different product types. They are four
// configurations of the same small set of rules" -- and then the interface
// shipped the four types anyway.
//
// SO THERE ARE TWO QUESTIONS, NOT FOUR MODELS
// -------------------------------------------
//   1. Can they order any amount they like, or only in boxes you set up?
//   2. If boxes: what is in a box, and does the buyer pick the colour?
//
// WHAT THIS IS NOT
// ----------------
// Not a checkout. No money is paid through this app -- migration 060 records
// that decision in Hadi's own words. Prices appear because a buyer must know
// what they are committing to before they send an order. The final button in
// the buyer's flow says "Submit order", and checks/check_no_payment_path.mjs
// exists to keep it that way.
// =============================================================================

import { esc } from "../lib/utils.js";
import { toast } from "./toast.js";
import { setBaseUnit } from "../data/size-ratios.js";
import { setProductMoq, setSellingModel } from "../data/pricing-admin.js";
import { listPacksForProduct, createPack, archivePack } from "../data/prepacks.js";
// PRESERVED, not dropped. CR-0001 named the 64-row builder for deletion but
// did not name these two, and they lived only inside it:
//   suggestPackRatio  -- "Suggest ratio from sell-through"
//   listRatios        -- the saved-mix library
// Deleting a working feature because the change order forgot to mention it is
// precisely the silent loss this repo keeps a ledger about. Both come across
// as shortcuts that fill the same grid.
import { suggestPackRatio } from "../data/prepacks.js";
import { listRatios, ratioShorthand } from "../data/size-ratios.js";

/** Colour names of a product, in the order its variants were created. */
function coloursOf(product) {
  const seen = [];
  (product.variants || []).forEach((v) => {
    const c = v.extra_attrs?.color ?? v.color;
    if (c && !seen.includes(c)) seen.push(c);
  });
  return seen;
}

/** Size names, same ordering rule. Left-to-right order matters: a size run
 *  read out of order turns "2 Small, 3 Medium" into nonsense. */
function sizesOf(product) {
  const seen = [];
  (product.variants || []).forEach((v) => {
    const s = v.extra_attrs?.size ?? v.size;
    if (s && !seen.includes(s)) seen.push(s);
  });
  return seen;
}

function variantAt(product, colour, size) {
  return (product.variants || []).find((v) => {
    const c = v.extra_attrs?.color ?? v.color;
    const s = v.extra_attrs?.size ?? v.size;
    return c === colour && s === size;
  }) || null;
}

/**
 * @param {object}   o
 * @param {object}   o.product   { id, name, selling_model, base_unit, moq_qty,
 *                                 moq_per_colour, variants: [...] }
 * @param {string}   o.wid
 * @param {Function} [o.onSaved] Called after anything is written, so the
 *                               caller can refetch. Never called on failure.
 * @returns {HTMLElement}
 */
export function renderOrderSetup({ product, wid, onSaved = () => {}, onAddVariants = null }) {
  const el = document.createElement("div");
  el.className = "order-setup";

  const colours = coloursOf(product);
  const sizes = sizesOf(product);

  // A product with no colours or sizes cannot have a box described over it.
  // Say what is missing and stop -- rather than rendering an empty grid that
  // looks broken.
  if (!colours.length || !sizes.length) {
    // NOT a dead end. The first draft of this component stated the rule and
    // stopped, and checks/check_packs_panel_reachable.mjs caught it -- the old
    // builder had a way out of exactly this state and it would have been lost
    // silently. It is the same mistake as the "N on hand" box that stated a
    // rule and refused to say where the rule is satisfied.
    el.innerHTML = `
      <div class="os-title">How do buyers order this?</div>
      <div class="os-sub">This product has ${colours.length ? "no sizes" : "no colours or sizes"} yet.
      A box is described as “how many of each size, in each colour”, so there is
      nothing to describe until they exist.</div>`;
    if (onAddVariants) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn btn-primary";
      add.style.marginTop = "12px";
      add.textContent = "Add colours & sizes";
      // Opens the REAL product editor -- one editor, never a second half-copy
      // that drifts -- and comes back here with the grid populated.
      add.addEventListener("click", () => onAddVariants());
      el.appendChild(add);
    }
    return el;
  }

  // Boxes-only covers what used to be called prepack, ratio and series.
  const startsInBoxes = ["prepack", "ratio", "series"].includes(product.selling_model);

  el.innerHTML = `
    <div class="os-title">How do buyers order this?</div>

    <label class="os-choice">
      <input type="radio" name="os-mode" value="open" ${startsInBoxes ? "" : "checked"}>
      <span><strong>Any amount they like</strong><br>
        <span class="os-hint">They pick colours, sizes and quantities freely.</span></span>
    </label>

    <label class="os-choice">
      <input type="radio" name="os-mode" value="boxes" ${startsInBoxes ? "checked" : ""}>
      <span><strong>Only in boxes I set up</strong><br>
        <span class="os-hint">They cannot buy loose pieces. You decide what a box holds.</span></span>
    </label>

    <div class="os-pane" id="os-open"></div>
    <div class="os-pane" id="os-boxes"></div>
  `;

  const openPane = el.querySelector("#os-open");
  const boxPane = el.querySelector("#os-boxes");

  // ---------------------------------------------------------------- OPEN ---
  // The two settings that drive the buyer's card and, until now, had their
  // ONLY control buried inside the ratio drawer nobody could navigate. Live
  // evidence, 24 Aug: not one of the four products had base_unit set. The
  // buyer-side multiplier has been built and working since Batch 5 and had
  // never once been switched on.
  openPane.innerHTML = `
    <div class="os-field">
      <label class="os-label" for="os-unit">Each “+” adds this many pieces</label>
      <input class="input os-num" id="os-unit" type="number" min="1" inputmode="numeric"
             value="${product.base_unit != null && product.base_unit > 1 ? product.base_unit : ""}"
             placeholder="1">
      <div class="os-hint">Leave blank to sell by the single piece. Set it to 12 and the buyer
        sees the price for one piece, but every tap of “+” adds 12.</div>
    </div>
    <div class="os-field">
      <label class="os-label" for="os-moq-colour">At least this many pieces of each colour</label>
      <input class="input os-num" id="os-moq-colour" type="number" min="1" inputmode="numeric"
             value="${product.moq_per_colour ?? ""}" placeholder="no minimum">
      <div class="os-hint">The usual trade rule — “12 per colour”. Blank means no minimum.</div>
    </div>
    <div class="os-field">
      <label class="os-label" for="os-moq-total">At least this many pieces in total</label>
      <input class="input os-num" id="os-moq-total" type="number" min="1" inputmode="numeric"
             value="${product.moq_qty ?? ""}" placeholder="no minimum">
    </div>
    <div class="os-preview" id="os-open-preview"></div>
    <button class="btn btn-primary" id="os-save-open" type="button">Save</button>
  `;

  const unitEl = openPane.querySelector("#os-unit");
  const moqColEl = openPane.querySelector("#os-moq-colour");
  const moqTotEl = openPane.querySelector("#os-moq-total");
  const openPreview = openPane.querySelector("#os-open-preview");

  // The sentence is the whole point. Hadi could not tell what he was building;
  // this says what the buyer will experience, in words, while he types.
  function paintOpenPreview() {
    const n = parseInt(unitEl.value, 10);
    const min = parseInt(moqColEl.value, 10);
    const bits = [];
    bits.push(n > 1
      ? `A buyer taps “+” once and gets <strong>${n} pieces</strong>.`
      : `A buyer taps “+” once and gets <strong>1 piece</strong>.`);
    if (Number.isFinite(min) && min > 0) bits.push(`They must take at least <strong>${min}</strong> of any colour they pick.`);
    openPreview.innerHTML = bits.join(" ");
  }
  [unitEl, moqColEl, moqTotEl].forEach((i) => i.addEventListener("input", paintOpenPreview));
  paintOpenPreview();

  openPane.querySelector("#os-save-open").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    await setBaseUnit(product.id, unitEl.value);
    await setProductMoq(product.id, {
      moqQty: moqTotEl.value === "" ? null : parseInt(moqTotEl.value, 10),
      moqPerColour: moqColEl.value === "" ? null : parseInt(moqColEl.value, 10),
    });
    const r = await setSellingModel(product.id, "open");
    btn.disabled = false;
    if (r?.error) return toast("Could not save that.", { type: "danger" });
    toast("Saved — buyers can order any amount.", { type: "success" });
    onSaved();
  });

  // --------------------------------------------------------------- BOXES ---
  boxPane.innerHTML = `
    <div class="os-hint" style="margin-bottom:10px;">
      Type how many of each size goes in a box. Fill it in by hand, or use a shortcut.
    </div>
    <div class="os-shortcuts">
      <button class="btn btn-secondary btn-sm" id="os-same" type="button">Same mix for every colour</button>
      <button class="btn btn-secondary btn-sm" id="os-all" type="button">N of everything</button>
      <button class="btn btn-secondary btn-sm" id="os-suggest" type="button">Suggest from what sells</button>
      <button class="btn btn-ghost btn-sm" id="os-clear" type="button">Clear</button>
    </div>
    <div class="os-saved" id="os-saved"></div>
    <div class="os-grid-scroll"><table class="os-grid"><thead></thead><tbody></tbody></table></div>
    <label class="os-choice os-switch">
      <input type="checkbox" id="os-per-colour" checked>
      <span><strong>Buyer picks the colour</strong><br>
        <span class="os-hint">On — one box per colour, and they choose which.
        Off — one fixed box holding everything below, and they choose nothing.</span></span>
    </label>
    <div class="os-preview" id="os-box-preview"></div>
    <div class="os-hint" id="os-replace-note"></div>
    <button class="btn btn-primary" id="os-save-boxes" type="button">Save the boxes</button>
  `;

  const table = boxPane.querySelector(".os-grid");
  const perColourEl = boxPane.querySelector("#os-per-colour");
  const boxPreview = boxPane.querySelector("#os-box-preview");
  const replaceNote = boxPane.querySelector("#os-replace-note");

  // qty[colour][size] -> input element
  const cellInputs = new Map();

  table.querySelector("thead").innerHTML =
    `<tr><th class="os-corner"></th>${sizes.map((s) => `<th>${esc(s)}</th>`).join("")}</tr>`;

  const tbody = table.querySelector("tbody");
  colours.forEach((colour) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.className = "os-rowhead";
    th.textContent = colour;
    tr.appendChild(th);
    const row = new Map();
    sizes.forEach((size) => {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.className = "input os-cell";
      inp.type = "number";
      inp.min = "0";
      inp.inputMode = "numeric";
      inp.value = "0";
      inp.setAttribute("aria-label", `${colour}, size ${size}`);
      // A cell with no matching variant cannot be ordered, so it cannot be in
      // a box. Disabled rather than hidden, so the grid keeps its shape and
      // the gap is visible instead of silently shifting the columns.
      if (!variantAt(product, colour, size)) {
        inp.disabled = true;
        inp.value = "";
        inp.title = `There is no ${colour} in size ${size} on this product.`;
      }
      inp.addEventListener("input", paintBoxPreview);
      row.set(size, inp);
      td.appendChild(inp);
      tr.appendChild(td);
    });
    cellInputs.set(colour, row);
    tbody.appendChild(tr);
  });

  const cellVal = (c, s) => {
    const i = cellInputs.get(c)?.get(s);
    if (!i || i.disabled) return 0;
    return parseInt(i.value, 10) || 0;
  };

  // ---- the two shortcuts. Neither is a mode: both just write numbers into
  // the same grid, and every cell stays editable afterwards. That is what
  // "fully flexible" means here.
  boxPane.querySelector("#os-same").addEventListener("click", () => {
    const first = colours[0];
    const mix = sizes.map((s) => cellVal(first, s));
    if (!mix.some((n) => n > 0)) {
      toast(`Fill in the ${first} row first — that row is the mix that gets copied.`, { type: "info" });
      return;
    }
    colours.slice(1).forEach((c) => sizes.forEach((s, i) => {
      const inp = cellInputs.get(c).get(s);
      if (!inp.disabled) inp.value = String(mix[i]);
    }));
    paintBoxPreview();
    toast(`Copied the ${first} mix to every colour.`, { type: "success" });
  });

  boxPane.querySelector("#os-all").addEventListener("click", () => {
    // Deliberately no native dialog here -- they are banned, and this is
    // exactly the sort of quick question that used to reach for one. The
    // number is taken from the first cell already filled, or 1.
    const seed = (() => {
      for (const c of colours) for (const s of sizes) { const v = cellVal(c, s); if (v > 0) return v; }
      return 1;
    })();
    colours.forEach((c) => sizes.forEach((s) => {
      const inp = cellInputs.get(c).get(s);
      if (!inp.disabled) inp.value = String(seed);
    }));
    paintBoxPreview();
    toast(`Every size, every colour, ${seed} each.`, { type: "success" });
  });

  // PRESERVED FEATURE 1 — the sell-through suggestion. It answers "what mix
  // should I put in a box?" from what actually sold, which is the one question
  // a starter curve cannot answer for a specific product.
  boxPane.querySelector("#os-suggest").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const { ratios } = await suggestPackRatio(product.id, (product.variants || []).map((v) => v.id));
    btn.disabled = false;
    if (!ratios || !ratios.length) return toast("Not enough sales history yet to suggest a mix.", { type: "info" });
    let filled = 0;
    ratios.forEach(({ variantId, qtyPerPack }) => {
      const v = (product.variants || []).find((x) => x.id === variantId);
      if (!v) return;
      const c = v.extra_attrs?.color ?? v.color;
      const sz = v.extra_attrs?.size ?? v.size;
      const inp = cellInputs.get(c)?.get(sz);
      if (inp && !inp.disabled) { inp.value = String(qtyPerPack); filled++; }
    });
    paintBoxPreview();
    toast(filled ? "Filled from what has been selling. Change anything you like." : "Nothing matched this product's colours and sizes.", { type: filled ? "success" : "info" });
  });

  boxPane.querySelector("#os-clear").addEventListener("click", () => {
    cellInputs.forEach((row) => row.forEach((i) => { if (!i.disabled) i.value = "0"; }));
    paintBoxPreview();
  });

  perColourEl.addEventListener("change", paintBoxPreview);

  /** What a buyer actually receives, spelled out. */
  function paintBoxPreview() {
    const perColour = perColourEl.checked;
    if (perColour) {
      const filled = colours.filter((c) => sizes.some((s) => cellVal(c, s) > 0));
      if (!filled.length) { boxPreview.textContent = "Put a number in at least one cell."; return; }
      const c = filled[0];
      const parts = sizes.filter((s) => cellVal(c, s) > 0).map((s) => `${cellVal(c, s)} ${s}`);
      const total = sizes.reduce((t, s) => t + cellVal(c, s), 0);
      boxPreview.innerHTML =
        `A buyer ordering <strong>1 box of ${esc(c)}</strong> gets <strong>${esc(parts.join(", "))}</strong> — ${total} pieces.` +
        (filled.length > 1 ? `<br><span class="os-hint">${filled.length} colours have a box. They pick which.</span>` : "");
    } else {
      const parts = [];
      let total = 0;
      colours.forEach((c) => sizes.forEach((s) => {
        const n = cellVal(c, s);
        if (n > 0) { parts.push(`${n} ${c} ${s}`); total += n; }
      }));
      if (!parts.length) { boxPreview.textContent = "Put a number in at least one cell."; return; }
      boxPreview.innerHTML =
        `A buyer ordering <strong>1 box</strong> gets <strong>${esc(parts.join(", "))}</strong> — ${total} pieces.` +
        `<br><span class="os-hint">One fixed box. They pick nothing.</span>`;
    }
  }

  boxPane.querySelector("#os-save-boxes").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const perColour = perColourEl.checked;

    const anything = colours.some((c) => sizes.some((s) => cellVal(c, s) > 0));
    if (!anything) return toast("Put a number in at least one cell first.", { type: "danger" });

    btn.disabled = true;
    btn.textContent = "Saving…";

    // The grid IS the boxes. Saving replaces what was there, so the screen and
    // the database cannot drift apart. Archiving is a soft flag, and past
    // orders are unaffected: migration 011 stores a fresh pack_line_id per
    // order line rather than the definition's id.
    const existing = await listPacksForProduct(product.id);
    for (const p of existing) await archivePack(p.id);

    let made = 0;
    if (perColour) {
      for (const c of colours) {
        const components = sizes
          .map((s) => ({ variantId: variantAt(product, c, s)?.id, qtyPerPack: cellVal(c, s) }))
          .filter((x) => x.variantId && x.qtyPerPack > 0);
        if (!components.length) continue;
        const r = await createPack(wid, product.id, { name: `${product.name} — ${c}`, color: c, components });
        if (r.ok) made++;
      }
    } else {
      const components = [];
      colours.forEach((c) => sizes.forEach((s) => {
        const v = variantAt(product, c, s);
        const n = cellVal(c, s);
        if (v && n > 0) components.push({ variantId: v.id, qtyPerPack: n });
      }));
      const r = await createPack(wid, product.id, { name: `${product.name} — Box`, color: null, components });
      if (r.ok) made++;
    }

    // prepack is the value whose server rule is "packs only". ratio and series
    // enforce the identical rule, so this is not a behaviour change -- it is
    // the same rule under the name that describes it plainly.
    const r = await setSellingModel(product.id, "prepack");
    btn.disabled = false;
    btn.textContent = "Save the boxes";
    if (r?.error) return toast("Boxes saved, but the product could not be switched to boxes-only.", { type: "danger" });
    toast(made === 1 ? "Saved — 1 box." : `Saved — ${made} boxes, one per colour.`, { type: "success" });
    onSaved();
  });

  // PRESERVED FEATURE 2 — the saved-mix library. CR-0001 (CH-11): reuse is a
  // convenience, never a gate. It appears only if there is something saved,
  // and it fills the first colour's row rather than taking over the grid.
  (async () => {
    const saved = await listRatios(wid).catch(() => []);
    const host = boxPane.querySelector("#os-saved");
    if (!saved || !saved.length) return;
    host.innerHTML = `<div class="os-hint" style="margin:8px 0 4px;">Or start from a mix you saved before:</div>`;
    saved.forEach((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-ghost btn-sm";
      b.textContent = `${r.name} (${ratioShorthand(r.weights)})`;
      b.addEventListener("click", () => {
        const first = colours[0];
        sizes.forEach((sz) => {
          const idx = (r.sizes || []).indexOf(sz);
          const inp = cellInputs.get(first)?.get(sz);
          if (inp && !inp.disabled) inp.value = idx >= 0 ? String(r.weights[idx]) : "0";
        });
        paintBoxPreview();
        toast(`Filled the ${first} row from "${r.name}". Use “Same mix for every colour” to copy it down.`, { type: "success" });
      });
      host.appendChild(b);
    });
  })();

  // ---- load whatever is already set up, so nothing is ever re-entered -----
  (async () => {
    // .catch: a failed load must leave an empty, usable grid rather than an
    // unhandled rejection and a panel that renders half of itself.
    const packs = await listPacksForProduct(product.id).catch(() => []);
    if (packs && packs.length) {
      perColourEl.checked = packs.some((p) => p.color);
      packs.forEach((p) => (p.components || []).forEach((comp) => {
        const v = (product.variants || []).find((x) => x.id === comp.variantId);
        if (!v) return;
        const c = v.extra_attrs?.color ?? v.color;
        const s = v.extra_attrs?.size ?? v.size;
        const inp = cellInputs.get(c)?.get(s);
        if (inp && !inp.disabled) inp.value = String(comp.qtyPerPack);
      }));
      replaceNote.textContent = `${packs.length} box${packs.length === 1 ? "" : "es"} already set up, shown above. Saving replaces them.`;
    }
    paintBoxPreview();
  })();

  // ---- which pane is visible -------------------------------------------
  function syncPanes() {
    const mode = el.querySelector('input[name="os-mode"]:checked').value;
    openPane.style.display = mode === "open" ? "" : "none";
    boxPane.style.display = mode === "boxes" ? "" : "none";
  }
  el.querySelectorAll('input[name="os-mode"]').forEach((r) => r.addEventListener("change", syncPanes));
  syncPanes();

  return el;
}
