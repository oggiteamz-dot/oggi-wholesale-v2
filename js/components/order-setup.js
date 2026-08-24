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
  // THREE KINDS OF PACK, because that is how Hadi says it out loud.
  //
  //   Full box  — every colour, every size, one size ratio.
  //               "four colours, four sizes... he will say I'll sell one small,
  //                three medium, three large and two XL." Same ratio in each
  //                colour by default, and any single colour can be overridden.
  //   By colour — one colour, all its sizes, ratio chosen.
  //   By size   — one size, all the colours, how many of each chosen.
  //
  // All three are the SAME colour x size grid underneath -- a full box fills
  // every row, "by colour" fills one row, "by size" fills one column. The kinds
  // are not modes and they are not stored: they are guided ways of filling the
  // grid, and every card can drop to the full grid and be edited by hand.
  // That is what keeps "give me the ability to do it in any which way that I
  // like" true while the common cases stay two taps.
  //
  // One product can carry any mix of them at once -- a full box, three colour
  // packs and two size packs -- and the buyer picks which they want. That is
  // already how v2_pack_definitions works: a list of packs per product.
  boxPane.innerHTML = `
    <div class="os-hint" style="margin-bottom:10px;">
      Each pack is one thing a buyer can order. Add as many as you like — you can mix all three kinds.
    </div>
    <div class="os-boxadd">
      <button class="btn btn-primary btn-sm"   id="os-add-full"   type="button">+ Full box</button>
      <button class="btn btn-secondary btn-sm" id="os-add-colour" type="button">+ By colour</button>
      <button class="btn btn-secondary btn-sm" id="os-add-size"   type="button">+ By size</button>
    </div>
    <div id="os-boxlist"></div>
    <div class="os-hint" id="os-replace-note"></div>
    <button class="btn btn-primary" id="os-save-boxes" type="button">Save the packs</button>
  `;

  const boxList    = boxPane.querySelector("#os-boxlist");
  const replaceNote= boxPane.querySelector("#os-replace-note");
  const boxes      = [];
  let boxSeq       = 0;
  const savedRatiosPromise = listRatios(wid).catch(() => []);

  const KIND_LABEL = { full: "Full box", colour: "By colour", size: "By size" };
  const exists = (c, s2) => !!variantAt(product, c, s2);
  const getQ   = (b, c, s2) => b.qty.get(c + "|" + s2) || 0;
  const setQ   = (b, c, s2, n) => {
    if (!exists(c, s2)) return;              // never invent stock that has no variant
    b.qty.set(c + "|" + s2, Math.max(0, n));
  };
  const coloursIn = (b) => colours.filter((c) => sizes.some((s2) => getQ(b, c, s2) > 0));
  const sizesIn   = (b) => sizes.filter((s2) => colours.some((c) => getQ(b, c, s2) > 0));
  const totalIn   = (b) => colours.reduce((t, c) => t + sizes.reduce((t2, s2) => t2 + getQ(b, c, s2), 0), 0);

  /** A swatch + photo + name, the way a wholesaler recognises a colour. */
  function colourTag(c) {
    const { hex, image } = colourMeta(product, c);
    return image
      ? `<img class="os-chip-img" src="${esc(image)}" alt=""><span>${esc(c)}</span>`
      : `<span class="os-chip-dot" style="background:${esc(hex)}"></span><span>${esc(c)}</span>`;
  }

  /** A −/n/+ stepper. `read`/`write` keep the numbers in box.qty, never in
   *  the DOM, so a card can be re-rendered into a different shape (the grid)
   *  without losing anything. */
  function stepper(label, read, write, onChange) {
    const el = document.createElement("div");
    el.className = "os-stepcell";
    el.innerHTML = `<div class="os-steplbl">${esc(label)}</div>
      <div class="os-step"><button type="button" data-d="-1">−</button><span class="os-stepn">0</span><button type="button" data-d="1">+</button></div>`;
    const n = el.querySelector(".os-stepn");
    const sync = () => { n.textContent = read(); };
    el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      write(Math.max(0, read() + Number(b.dataset.d)));
      sync(); onChange();
    }));
    sync();
    return { el, sync };
  }

  function addBox(kind, { name = "", colour = null, size = null, qty = null } = {}) {
    boxSeq += 1;
    const box = {
      kind,
      qty: qty || new Map(),
      colour: colour || colours[0],
      size: size || sizes[0],
      expanded: false,
      defaultName: "",
    };
    box.defaultName =
      kind === "colour" ? `${product.name} — ${box.colour}`
      : kind === "size" ? `${product.name} — size ${box.size}`
      : `${product.name} — Full box ${boxSeq}`;

    const card = document.createElement("div");
    card.className = "os-box";
    card.innerHTML = `
      <div class="os-box-head">
        <span class="os-kind os-kind-${kind}">${KIND_LABEL[kind]}</span>
        <input class="input os-box-name" type="text" placeholder="${esc(box.defaultName)}">
        <span class="os-box-count"></span>
        <button class="btn btn-ghost btn-sm os-box-dup" type="button">Duplicate</button>
        <button class="btn btn-ghost btn-sm os-box-del" type="button">Remove</button>
      </div>
      <div class="os-box-editor"></div>
      <div class="os-preview os-box-preview"></div>`;

    box.card       = card;
    box.nameInput  = card.querySelector(".os-box-name");
    box.count      = card.querySelector(".os-box-count");
    box.editor     = card.querySelector(".os-box-editor");
    box.preview    = card.querySelector(".os-box-preview");
    if (name) box.nameInput.value = name;
    box.nameInput.addEventListener("input", () => paintPreview(box));

    card.querySelector(".os-box-dup").addEventListener("click", () => {
      addBox(box.kind, {
        name: (box.nameInput.value.trim() || box.defaultName) + " copy",
        colour: box.colour, size: box.size, qty: new Map(box.qty),
      });
    });
    card.querySelector(".os-box-del").addEventListener("click", () => {
      const i = boxes.indexOf(box);
      if (i >= 0) boxes.splice(i, 1);
      card.remove();
    });

    boxes.push(box);
    boxList.appendChild(card);
    renderEditor(box);
    return box;
  }

  function renderEditor(box) {
    box.editor.innerHTML = "";
    const refresh = () => paintPreview(box);

    // ---------- FULL BOX: one ratio, applied to every colour ----------
    if (box.kind === "full" && !box.expanded) {
      const hint = document.createElement("div");
      hint.className = "os-hint";
      hint.textContent = `How many of each size, in every colour. ${colours.length} colours share this ratio.`;
      box.editor.appendChild(hint);

      const row = document.createElement("div");
      row.className = "os-steprow";
      sizes.forEach((s2) => {
        const live = colours.filter((c) => exists(c, s2));
        if (!live.length) return;
        const st = stepper(s2,
          () => getQ(box, live[0], s2),
          (n) => live.forEach((c) => setQ(box, c, s2, n)),
          refresh);
        row.appendChild(st.el);
      });
      box.editor.appendChild(row);

      // The two shortcuts that have now fallen out of three consecutive
      // rewrites of this panel. They live on the FULL BOX because that is the
      // card with a size ratio to fill, which is what both of them produce.
      const tools = document.createElement("div");
      tools.className = "os-shortcuts";

      const sug = document.createElement("button");
      sug.type = "button";
      sug.className = "btn btn-secondary btn-sm";
      sug.textContent = "Suggest from what sells";
      sug.addEventListener("click", async () => {
        sug.disabled = true;
        const { ratios } = await suggestPackRatio(product.id, (product.variants || []).map((v) => v.id));
        sug.disabled = false;
        if (!ratios || !ratios.length) return toast("Not enough sales history yet to suggest a ratio.", { type: "info" });
        // Collapse the suggestion to ONE ratio per size -- a full box is a
        // single ratio repeated across colours, so the per-variant suggestion
        // is averaged rather than pasted in colour by colour.
        const bySize = new Map();
        ratios.forEach(({ variantId, qtyPerPack }) => {
          const v = (product.variants || []).find((x) => x.id === variantId);
          if (!v) return;
          const sz = v.extra_attrs?.size ?? v.size;
          const cur = bySize.get(sz) || [];
          cur.push(qtyPerPack); bySize.set(sz, cur);
        });
        sizes.forEach((s2) => {
          const vals = bySize.get(s2);
          if (!vals || !vals.length) return;
          const avg = Math.max(1, Math.round(vals.reduce((a, b2) => a + b2, 0) / vals.length));
          colours.filter((c) => exists(c, s2)).forEach((c) => setQ(box, c, s2, avg));
        });
        renderEditor(box); paintPreview(box);
        toast("Filled from what has been selling. Change anything you like.", { type: "success" });
      });
      tools.appendChild(sug);
      box.editor.appendChild(tools);

      const savedHost = document.createElement("div");
      savedHost.className = "os-saved";
      box.editor.appendChild(savedHost);
      savedRatiosPromise.then((saved) => {
        if (!saved || !saved.length) return;
        savedHost.innerHTML = `<span class="os-hint">Or start from a ratio you saved before:</span> `;
        saved.forEach((r) => {
          const b2 = document.createElement("button");
          b2.type = "button";
          b2.className = "btn btn-ghost btn-sm";
          b2.textContent = `${r.name} (${ratioShorthand(r.weights)})`;
          b2.addEventListener("click", () => {
            sizes.forEach((s2) => {
              const idx = (r.sizes || []).indexOf(s2);
              const n = idx >= 0 ? r.weights[idx] : 0;
              colours.filter((c) => exists(c, s2)).forEach((c) => setQ(box, c, s2, n));
            });
            renderEditor(box); paintPreview(box);
            toast(`Filled from "${r.name}".`, { type: "success" });
          });
          savedHost.appendChild(b2);
        });
      });

      const more = document.createElement("button");
      more.type = "button";
      more.className = "btn btn-ghost btn-sm";
      more.style.marginTop = "8px";
      more.textContent = "One colour is different →";
      more.title = "Open the full grid and change any single colour";
      more.addEventListener("click", () => { box.expanded = true; renderEditor(box); paintPreview(box); });
      box.editor.appendChild(more);
      return;
    }

    // ---------- BY COLOUR: pick a colour, then its sizes ----------
    if (box.kind === "colour") {
      const pick = document.createElement("div");
      pick.className = "os-pick";
      colours.forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "os-pickchip" + (c === box.colour ? " on" : "");
        b.innerHTML = colourTag(c);
        b.addEventListener("click", () => {
          // moving the pack to another colour moves its numbers with it
          const old = box.colour;
          if (old === c) return;
          sizes.forEach((s2) => { const n = getQ(box, old, s2); setQ(box, old, s2, 0); setQ(box, c, s2, n); });
          box.colour = c;
          if (!box.nameInput.value.trim()) box.defaultName = `${product.name} — ${c}`;
          renderEditor(box); paintPreview(box);
        });
        pick.appendChild(b);
      });
      box.editor.appendChild(pick);

      const row = document.createElement("div");
      row.className = "os-steprow";
      sizes.filter((s2) => exists(box.colour, s2)).forEach((s2) => {
        row.appendChild(stepper(s2, () => getQ(box, box.colour, s2), (n) => setQ(box, box.colour, s2, n), refresh).el);
      });
      box.editor.appendChild(row);
      return;
    }

    // ---------- BY SIZE: pick a size, then how many of each colour ----------
    if (box.kind === "size") {
      const pick = document.createElement("div");
      pick.className = "os-pick";
      sizes.forEach((s2) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "os-pickchip" + (s2 === box.size ? " on" : "");
        b.textContent = s2;
        b.addEventListener("click", () => {
          const old = box.size;
          if (old === s2) return;
          colours.forEach((c) => { const n = getQ(box, c, old); setQ(box, c, old, 0); setQ(box, c, s2, n); });
          box.size = s2;
          if (!box.nameInput.value.trim()) box.defaultName = `${product.name} — size ${s2}`;
          renderEditor(box); paintPreview(box);
        });
        pick.appendChild(b);
      });
      box.editor.appendChild(pick);

      const list = document.createElement("div");
      list.className = "os-colrows";
      colours.filter((c) => exists(c, box.size)).forEach((c) => {
        const r = document.createElement("div");
        r.className = "os-colrow";
        const tag = document.createElement("div");
        tag.className = "os-chip";
        tag.innerHTML = colourTag(c);
        r.appendChild(tag);
        r.appendChild(stepper("", () => getQ(box, c, box.size), (n) => setQ(box, c, box.size, n), refresh).el);
        list.appendChild(r);
      });
      box.editor.appendChild(list);
      return;
    }

    // ---------- the full grid, for anything the guided editors cannot say ----
    const back = document.createElement("button");
    back.type = "button";
    back.className = "btn btn-ghost btn-sm";
    back.textContent = "← Back to one ratio for every colour";
    back.addEventListener("click", () => { box.expanded = false; renderEditor(box); paintPreview(box); });
    box.editor.appendChild(back);

    const wrap = document.createElement("div");
    wrap.className = "os-grid-scroll";
    const table = document.createElement("table");
    table.className = "os-grid";
    table.innerHTML = `<thead><tr><th class="os-corner"></th>${sizes.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody></tbody>`;
    const tbody = table.querySelector("tbody");
    colours.forEach((c) => {
      const { hex, image } = colourMeta(product, c);
      const tr = document.createElement("tr");
      tr.innerHTML = `<th class="os-rowhead"><span class="os-rowhead-inner">${
        image ? `<img class="os-rowimg" src="${esc(image)}" alt="">`
              : `<span class="os-rowdot" style="background:${esc(hex)}"></span>`
      }<span class="os-rowname">${esc(c)}</span></span></th>`;
      sizes.forEach((s2) => {
        const td = document.createElement("td");
        const inp = document.createElement("input");
        inp.className = "input os-cell";
        inp.type = "number"; inp.min = "0"; inp.inputMode = "numeric";
        if (!exists(c, s2)) { inp.disabled = true; inp.value = ""; inp.title = `There is no ${c} in size ${s2}.`; }
        else {
          inp.value = String(getQ(box, c, s2));
          inp.addEventListener("input", () => { setQ(box, c, s2, parseInt(inp.value, 10) || 0); paintPreview(box); });
        }
        td.appendChild(inp);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    wrap.appendChild(table);
    box.editor.appendChild(wrap);
  }

  function paintPreview(box) {
    const total = totalIn(box);
    const name = box.nameInput.value.trim() || box.defaultName;
    box.count.textContent = total ? `${total} pieces` : "empty";

    if (!total) { box.preview.textContent = "Put a number in at least one size."; return; }

    if (box.kind === "full") {
      const cs = coloursIn(box);
      const ref = cs[0];
      const parts = sizes.filter((s2) => getQ(box, ref, s2) > 0).map((s2) => `${getQ(box, ref, s2)} ${s2}`);
      const perColour = sizes.reduce((t, s2) => t + getQ(box, ref, s2), 0);
      const even = cs.every((c) => sizes.every((s2) => !exists(c, s2) || getQ(box, c, s2) === getQ(box, ref, s2)));
      box.preview.innerHTML = even
        ? `A buyer ordering <strong>1 × ${esc(name)}</strong> gets <strong>${esc(parts.join(", "))}</strong> in each of ${cs.length} colours — ${total} pieces.`
        : `A buyer ordering <strong>1 × ${esc(name)}</strong> gets ${total} pieces across ${cs.length} colours. <span class="os-hint">Colours differ — open the grid to see exactly.</span>`;
      return;
    }
    if (box.kind === "colour") {
      const parts = sizes.filter((s2) => getQ(box, box.colour, s2) > 0).map((s2) => `${getQ(box, box.colour, s2)} ${s2}`);
      box.preview.innerHTML = `A buyer ordering <strong>1 × ${esc(name)}</strong> gets <strong>${esc(parts.join(", "))}</strong> in ${esc(box.colour)} — ${total} pieces.`;
      return;
    }
    const parts = colours.filter((c) => getQ(box, c, box.size) > 0).map((c) => `${getQ(box, c, box.size)} ${c}`);
    box.preview.innerHTML = `A buyer ordering <strong>1 × ${esc(name)}</strong> gets <strong>${esc(parts.join(", "))}</strong> — all in size ${esc(box.size)}, ${total} pieces.`;
  }

  boxPane.querySelector("#os-add-full").addEventListener("click", () => {
    const b = addBox("full"); paintPreview(b); b.nameInput.focus();
  });
  boxPane.querySelector("#os-add-colour").addEventListener("click", () => {
    const b = addBox("colour"); paintPreview(b); b.nameInput.focus();
  });
  boxPane.querySelector("#os-add-size").addEventListener("click", () => {
    const b = addBox("size"); paintPreview(b); b.nameInput.focus();
  });

  boxPane.querySelector("#os-save-boxes").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const live = boxes.filter((b) => totalIn(b) > 0);
    if (!live.length) return toast("Put a number in at least one pack first.", { type: "danger" });

    btn.disabled = true; btn.textContent = "Saving…";

    // The list IS the packs, so saving replaces what was there and the screen
    // cannot drift from the database. Archiving is a soft flag and past orders
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
        const n = getQ(b, c, s2);
        if (v && n > 0) components.push({ variantId: v.id, qtyPerPack: n });
      }));
      const r = await createPack(wid, product.id, {
        name: b.nameInput.value.trim() || b.defaultName,
        // One colour -> recorded as that colour, which is what makes it show
        // as a colour choice to the buyer. Spanning colours -> none; migration
        // 011 made the column nullable for exactly that.
        color: cs.length === 1 ? cs[0] : null,
        components,
      });
      if (r.ok) made++;
    }

    const r = await setSellingModel(product.id, "prepack");
    btn.disabled = false; btn.textContent = "Save the packs";
    if (r?.error) return toast("Packs saved, but the product could not be switched to packs-only.", { type: "danger" });
    toast(made === 1 ? "Saved — 1 pack." : `Saved — ${made} packs.`, { type: "success" });
    onSaved();
  });

  // ---- load what already exists, one card per pack -----------------------
  (async () => {
    const packs = await listPacksForProduct(product.id).catch(() => []);
    if (packs && packs.length) {
      packs.forEach((pk) => {
        const qty = new Map();
        (pk.components || []).forEach((comp) => {
          const v = (product.variants || []).find((x) => x.id === comp.variantId);
          if (!v) return;
          const c = v.extra_attrs?.color ?? v.color;
          const s2 = v.extra_attrs?.size ?? v.size;
          qty.set(c + "|" + s2, comp.qtyPerPack);
        });
        // Work out which kind it is FROM THE DATA rather than storing a type:
        // one colour -> by colour, one size -> by size, otherwise a full box.
        const cs = colours.filter((c) => sizes.some((s2) => (qty.get(c + "|" + s2) || 0) > 0));
        const ss = sizes.filter((s2) => colours.some((c) => (qty.get(c + "|" + s2) || 0) > 0));
        const kind = cs.length === 1 ? "colour" : ss.length === 1 ? "size" : "full";
        const b = addBox(kind, { name: pk.name, colour: cs[0], size: ss[0], qty });
        paintPreview(b);
      });
      replaceNote.textContent = `${packs.length} pack${packs.length === 1 ? "" : "s"} already set up, shown above. Saving replaces them.`;
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
