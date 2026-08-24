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

/**
 * Swatch and photo for a colour.  Added 24 Aug 2026.
 *
 * Hadi: "I can read blue, green, navy, whatever. I don't know if these are the
 * right names for them, and I might forget... I want to see the actual colour.
 * Also I want to see the small image of the product."
 *
 * Both were already in the data and neither was on screen -- the recurring
 * shape of this codebase's failures. `extra_attrs.colorHex` has been written
 * on every variant since migration 001, and per-colour photos already drive
 * the BUYER's card through imagesByColor() in js/data/catalog.js. The setup
 * screen, where the wholesaler decides what goes in a box, showed a word.
 *
 * A word is the weakest possible identifier here: "Navy" and "Blue" are two
 * taps apart in a grid and nothing on screen distinguishes them.
 */
function colourMeta(product, colour) {
  const vs = (product.variants || []).filter((v) => (v.extra_attrs?.color ?? v.color) === colour);
  const hex = vs.map((v) => v.extra_attrs?.colorHex ?? v.colorHex).find(Boolean) || "#999";
  // First real photo on any variant of this colour. image_url first, then the
  // images array -- the same order js/data/catalog.js resolves them in, so the
  // wholesaler sees the picture the buyer will see rather than a second guess.
  const image = vs.map((v) => v.image_url || (Array.isArray(v.images) ? v.images[0] : null)).find(Boolean) || null;
  return { hex, image };
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
  //
  // A LIST of boxes, not one grid.  Rebuilt 24 Aug 2026, same day as the
  // first version, because the first version was a REGRESSION and Hadi caught
  // it within the hour.
  //
  // The builder this replaced could create any number of arbitrary packs --
  // one at a time, each with its own name, colour and quantities. The grid
  // that replaced it could express exactly two shapes: one mixed box, or one
  // box per colour. That is less than existed the morning it shipped, and the
  // gate did not catch it because the gate was written to match the new design
  // instead of to preserve the old capability. Writing a gate around your own
  // intention is how a feature-loss check goes green on a feature loss.
  //
  // Hadi: "I can create a box that sells all four colours, but only large and
  // medium. Then another box that only sells small and XL. In addition to this,
  // to be able to just do one blue with whatever ratio of sizes that I want...
  // Give me the ability to do it in any which way that I like."
  //
  // So: each box is its own card with its own grid. Nothing is derived from
  // anything else, which is what makes it arbitrary. This maps one-to-one onto
  // v2_pack_definitions, which has always been a LIST of packs per product --
  // the single-grid version was the odd one out, not this.
  boxPane.innerHTML = `
    <div class="os-hint" style="margin-bottom:10px;">
      Each box is one thing a buyer can order. Make as many as you like — different
      colours, different sizes, whatever you actually ship.
    </div>
    <div class="os-boxadd">
      <button class="btn btn-primary btn-sm" id="os-add-box" type="button">+ Add a box</button>
      <button class="btn btn-secondary btn-sm" id="os-add-per-colour" type="button">+ One box per colour</button>
    </div>
    <div id="os-boxlist"></div>
    <div class="os-hint" id="os-replace-note"></div>
    <button class="btn btn-primary" id="os-save-boxes" type="button">Save the boxes</button>
  `;

  const boxList = boxPane.querySelector("#os-boxlist");
  const replaceNote = boxPane.querySelector("#os-replace-note");
  const boxes = [];
  let boxSeq = 0;
  // PRESERVED FEATURE — the saved-mix library. It fell out of the rewrite once
  // already today and is being put back deliberately rather than rediscovered
  // later. Fetched ONCE and shared, so N box cards do not make N round trips.
  const savedRatiosPromise = listRatios(wid).catch(() => []);

  const cellVal = (box, c, s2) => {
    const i = box.cells.get(c)?.get(s2);
    if (!i || i.disabled) return 0;
    return parseInt(i.value, 10) || 0;
  };

  /** Which colours this box actually contains. Drives both the summary and
   *  whether the saved pack is a single-colour pack or a mixed one. */
  const coloursIn = (box) => colours.filter((c) => sizes.some((s2) => cellVal(box, c, s2) > 0));
  const totalIn = (box) => colours.reduce((t, c) => t + sizes.reduce((t2, s2) => t2 + cellVal(box, c, s2), 0), 0);

  function paintSummary(box) {
    const cs = coloursIn(box);
    const total = totalIn(box);
    box.summary.innerHTML = "";
    cs.forEach((c) => {
      const { hex, image } = colourMeta(product, c);
      const chip = document.createElement("span");
      chip.className = "os-chip";
      chip.title = c;
      chip.innerHTML = image
        ? `<img class="os-chip-img" src="${esc(image)}" alt="">`
        : `<span class="os-chip-dot" style="background:${esc(hex)}"></span>`;
      chip.append(document.createTextNode(c));
      box.summary.appendChild(chip);
    });
    box.count.textContent = total ? `${total} pieces` : "empty";
  }

  function paintPreview(box) {
    const cs = coloursIn(box);
    if (!cs.length) { box.preview.textContent = "Put a number in at least one cell."; paintSummary(box); return; }
    const parts = [];
    cs.forEach((c) => sizes.forEach((s2) => {
      const n = cellVal(box, c, s2);
      if (n > 0) parts.push(cs.length === 1 ? `${n} ${s2}` : `${n} ${c} ${s2}`);
    }));
    const name = box.nameInput.value.trim() || box.defaultName;
    box.preview.innerHTML =
      `A buyer ordering <strong>1 × ${esc(name)}</strong> gets <strong>${esc(parts.join(", "))}</strong> — ${totalIn(box)} pieces.`;
    paintSummary(box);
  }

  /**
   * One box card.
   * @param {object} [opts]
   * @param {string} [opts.name]
   * @param {Function} [opts.fill]  (colour, size) => number, to prefill
   */
  function addBox({ name = "", fill = null } = {}) {
    boxSeq += 1;
    const defaultName = `${product.name} — Box ${boxSeq}`;
    const card = document.createElement("div");
    card.className = "os-box";
    card.innerHTML = `
      <div class="os-box-head">
        <input class="input os-box-name" type="text" placeholder="${esc(defaultName)}">
        <span class="os-box-count"></span>
        <button class="btn btn-ghost btn-sm os-box-dup" type="button" title="Make a copy of this box">Duplicate</button>
        <button class="btn btn-ghost btn-sm os-box-del" type="button" title="Remove this box">Remove</button>
      </div>
      <div class="os-box-summary"></div>
      <div class="os-shortcuts">
        <button class="btn btn-secondary btn-sm os-b-same" type="button">Same mix for every colour</button>
        <button class="btn btn-secondary btn-sm os-b-all" type="button">N of everything</button>
        <button class="btn btn-secondary btn-sm os-b-suggest" type="button">Suggest from what sells</button>
        <button class="btn btn-ghost btn-sm os-b-clear" type="button">Clear</button>
      </div>
      <div class="os-saved os-b-saved"></div>
      <div class="os-grid-scroll"><table class="os-grid"><thead></thead><tbody></tbody></table></div>
      <div class="os-preview os-box-preview"></div>
    `;

    const box = {
      card,
      defaultName,
      nameInput: card.querySelector(".os-box-name"),
      summary: card.querySelector(".os-box-summary"),
      count: card.querySelector(".os-box-count"),
      preview: card.querySelector(".os-box-preview"),
      cells: new Map(),
    };
    if (name) box.nameInput.value = name;
    box.nameInput.addEventListener("input", () => paintPreview(box));

    const table = card.querySelector(".os-grid");
    table.querySelector("thead").innerHTML =
      `<tr><th class="os-corner"></th>${sizes.map((x) => `<th>${esc(x)}</th>`).join("")}</tr>`;
    const tbody = table.querySelector("tbody");

    colours.forEach((colour) => {
      const { hex, image } = colourMeta(product, colour);
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.className = "os-rowhead";
      // Swatch AND photo AND name. The name alone was the whole complaint.
      th.innerHTML = `
        <span class="os-rowhead-inner">
          ${image ? `<img class="os-rowimg" src="${esc(image)}" alt="">`
                  : `<span class="os-rowdot" style="background:${esc(hex)}"></span>`}
          <span class="os-rowname">${esc(colour)}</span>
        </span>`;
      tr.appendChild(th);
      const row = new Map();
      sizes.forEach((size) => {
        const td = document.createElement("td");
        const inp = document.createElement("input");
        inp.className = "input os-cell";
        inp.type = "number"; inp.min = "0"; inp.inputMode = "numeric"; inp.value = "0";
        inp.setAttribute("aria-label", `${colour}, size ${size}`);
        if (!variantAt(product, colour, size)) {
          inp.disabled = true; inp.value = "";
          inp.title = `There is no ${colour} in size ${size} on this product.`;
        } else if (fill) {
          inp.value = String(fill(colour, size) || 0);
        }
        inp.addEventListener("input", () => paintPreview(box));
        row.set(size, inp);
        td.appendChild(inp);
        tr.appendChild(td);
      });
      box.cells.set(colour, row);
      tbody.appendChild(tr);
    });

    // ---- per-box shortcuts. They fill THIS box only. -----------------------
    card.querySelector(".os-b-same").addEventListener("click", () => {
      const first = colours[0];
      const mix = sizes.map((s2) => cellVal(box, first, s2));
      if (!mix.some((n) => n > 0)) {
        toast(`Fill in the ${first} row of this box first — that row is the mix that gets copied.`, { type: "info" });
        return;
      }
      colours.slice(1).forEach((c) => sizes.forEach((s2, i) => {
        const inp = box.cells.get(c).get(s2);
        if (!inp.disabled) inp.value = String(mix[i]);
      }));
      paintPreview(box);
    });

    card.querySelector(".os-b-all").addEventListener("click", () => {
      // No native dialog. The number comes from the first cell already filled,
      // or 1 -- and every cell stays editable afterwards.
      let seed = 1;
      outer: for (const c of colours) for (const s2 of sizes) { const v = cellVal(box, c, s2); if (v > 0) { seed = v; break outer; } }
      colours.forEach((c) => sizes.forEach((s2) => {
        const inp = box.cells.get(c).get(s2);
        if (!inp.disabled) inp.value = String(seed);
      }));
      paintPreview(box);
    });

    card.querySelector(".os-b-suggest").addEventListener("click", async (ev) => {
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
        const inp = box.cells.get(c)?.get(sz);
        if (inp && !inp.disabled) { inp.value = String(qtyPerPack); filled++; }
      });
      paintPreview(box);
      toast(filled ? "Filled from what has been selling. Change anything you like." : "Nothing matched this product's colours and sizes.", { type: filled ? "success" : "info" });
    });

    card.querySelector(".os-b-clear").addEventListener("click", () => {
      box.cells.forEach((row) => row.forEach((i) => { if (!i.disabled) i.value = "0"; }));
      paintPreview(box);
    });

    card.querySelector(".os-box-dup").addEventListener("click", () => {
      addBox({
        name: (box.nameInput.value.trim() || box.defaultName) + " copy",
        fill: (c, s2) => cellVal(box, c, s2),
      });
    });

    card.querySelector(".os-box-del").addEventListener("click", () => {
      const i = boxes.indexOf(box);
      if (i >= 0) boxes.splice(i, 1);
      card.remove();
      if (!boxes.length) addBox();
    });

    // Optional reuse, never a gate: a box can be filled in by hand without
    // naming or saving anything, which was the wall Hadi hit in the old
    // builder. These only appear if there is something saved to reuse.
    savedRatiosPromise.then((saved) => {
      if (!saved || !saved.length) return;
      const host = card.querySelector(".os-b-saved");
      host.innerHTML = `<span class="os-hint">Start from a saved mix:</span> `;
      saved.forEach((r) => {
        const b2 = document.createElement("button");
        b2.type = "button";
        b2.className = "btn btn-ghost btn-sm";
        b2.textContent = `${r.name} (${ratioShorthand(r.weights)})`;
        b2.addEventListener("click", () => {
          const first = colours[0];
          sizes.forEach((sz) => {
            const idx = (r.sizes || []).indexOf(sz);
            const inp = box.cells.get(first)?.get(sz);
            if (inp && !inp.disabled) inp.value = idx >= 0 ? String(r.weights[idx]) : "0";
          });
          paintPreview(box);
          toast(`Filled the ${first} row from "${r.name}". Use “Same mix for every colour” to copy it down.`, { type: "success" });
        });
        host.appendChild(b2);
      });
    });

    boxes.push(box);
    boxList.appendChild(card);
    paintPreview(box);
    return box;
  }

  boxPane.querySelector("#os-add-box").addEventListener("click", () => {
    const b = addBox();
    b.card.scrollIntoView({ block: "nearest" });
    b.nameInput.focus();
  });

  // The old "buyer picks the colour" switch, as an action instead of a mode.
  // It adds N boxes -- one per colour -- and every one of them is then an
  // ordinary box you can edit or delete. Nothing is locked.
  boxPane.querySelector("#os-add-per-colour").addEventListener("click", () => {
    colours.forEach((c) => addBox({
      name: `${product.name} — ${c}`,
      fill: (cc) => (cc === c ? 1 : 0),
    }));
    toast(`Added ${colours.length} boxes, one per colour. Edit each one however you like.`, { type: "success" });
  });

  boxPane.querySelector("#os-save-boxes").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const live = boxes.filter((b) => totalIn(b) > 0);
    if (!live.length) return toast("Put a number in at least one box first.", { type: "danger" });

    btn.disabled = true;
    btn.textContent = "Saving…";

    // The list IS the boxes, so saving replaces what was there and the screen
    // and the database cannot drift. Archiving is a soft flag, and past orders
    // are unaffected: migration 011 stores a fresh pack_line_id per order line
    // rather than the definition's id.
    const existing = await listPacksForProduct(product.id).catch(() => []);
    for (const pk of existing) await archivePack(pk.id);

    let made = 0;
    for (const b of live) {
      const cs = coloursIn(b);
      const components = [];
      colours.forEach((c) => sizes.forEach((s2) => {
        const v = variantAt(product, c, s2);
        const n = cellVal(b, c, s2);
        if (v && n > 0) components.push({ variantId: v.id, qtyPerPack: n });
      }));
      const r = await createPack(wid, product.id, {
        name: b.nameInput.value.trim() || b.defaultName,
        // A single-colour box is recorded as that colour, which is what makes
        // it show as a colour choice to the buyer. A box spanning colours is
        // recorded with none -- migration 011 made the column nullable for
        // exactly this, and nothing had ever used it.
        color: cs.length === 1 ? cs[0] : null,
        components,
      });
      if (r.ok) made++;
    }

    const r = await setSellingModel(product.id, "prepack");
    btn.disabled = false;
    btn.textContent = "Save the boxes";
    if (r?.error) return toast("Boxes saved, but the product could not be switched to boxes-only.", { type: "danger" });
    toast(made === 1 ? "Saved — 1 box." : `Saved — ${made} boxes.`, { type: "success" });
    onSaved();
  });

  // ---- load what already exists, one card per box ------------------------
  (async () => {
    const packs = await listPacksForProduct(product.id).catch(() => []);
    if (packs && packs.length) {
      packs.forEach((pk) => {
        const byVariant = new Map((pk.components || []).map((c) => [c.variantId, c.qtyPerPack]));
        addBox({
          name: pk.name,
          fill: (c, s2) => byVariant.get(variantAt(product, c, s2)?.id) || 0,
        });
      });
      replaceNote.textContent = `${packs.length} box${packs.length === 1 ? "" : "es"} already set up, shown above. Saving replaces them.`;
    } else {
      addBox();
    }
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
