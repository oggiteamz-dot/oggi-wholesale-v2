// =============================================================================
// OGGI Wholesale v2 — NEW PRODUCT FORM
// =============================================================================
//
// ONE form, TWO entry points: the catalog builder and the Inventory screen.
// Hadi's ask, verbatim: "inside of the actual catalog builder, create new
// products. And when you create these new products, you automatically have
// them be put into the inventory. And inside the inventory, you can also make
// products."
//
// Two forms would have been quicker to write and would have drifted. This
// codebase already carries the HTML-escape helper in ten copies under four
// names and pageHeader in seven copies that have already diverged. The failure
// mode for a duplicated product form is quiet: one copy starts setting
// colorHex and the other does not, and the only symptom is "the products I add
// from Inventory look different from the ones I add from Catalogs".
//
// WHY IT IS NOT A MODAL
// ---------------------
// It renders inline, above the list it is adding to. A centred modal with six
// fields per variant is a bad shape on a 390px phone -- it either scrolls
// inside itself, which hides the submit button, or it covers the list the
// operator is checking their SKUs against. Inline means the page scrolls
// normally and the existing products stay visible underneath.
//
// VALIDATION HAPPENS TWICE, ON PURPOSE
// ------------------------------------
// Here, so the operator gets a specific sentence next to the field. And in
// createProduct(), because this component is not the only possible caller and
// a data layer that trusts its input is a data layer that will eventually be
// called by something that lied. The database has the final say via its own
// constraints (moq >= 1, selling model in a known set, SKU unique per product).
//
// COLOUR
// ------
// The swatch is the point, though the claim needs stating accurately: the v1
// data migration DID set real hexes, and every one of the 133 pre-existing
// variants carries one. Checked against the database rather than assumed --
// an earlier draft of this comment said all v2 products rendered grey, which
// was simply untrue.
//
// What is true: the CSV importer writes colour and size and no colorHex, so
// spreadsheet-imported variants fall back to js/data/catalog.js's "#999" and
// do draw grey. This form closes that gap for anything created by hand, and
// gives the operator a colour they can see while choosing it.
// =============================================================================

import { esc } from "../lib/utils.js";

/** A small, deliberately unfashionable palette: strong, distinguishable
 *  garment colours that survive being shown as a 28px square. The free
 *  <input type="color"> is there for anything not on it. */
const SWATCHES = [
  ["Black", "#111827"], ["White", "#FFFFFF"], ["Grey", "#9CA3AF"],
  ["Navy", "#1E3A5F"], ["Blue", "#2563EB"], ["Sky", "#7DD3FC"],
  ["Green", "#15803D"], ["Olive", "#4D7C0F"], ["Mint", "#54E5A0"],
  ["Red", "#B91C1C"], ["Burgundy", "#7F1D1D"], ["Pink", "#EC4899"],
  ["Orange", "#EA580C"], ["Mustard", "#CA8A04"], ["Cream", "#F5E9D3"],
  ["Beige", "#D6C3A5"], ["Brown", "#78350F"], ["Purple", "#7C3AED"],
];

const SELLING_MODELS = [
  ["open", "Open — buyers pick any quantity of any variant"],
  ["prepack", "Prepack — sold as fixed bundles"],
  ["series", "Series — sold as a full size run"],
  ["ratio", "Ratio — sized to a fixed curve"],
];

let uid = 0;
const nextId = () => `pf-${++uid}`;

/**
 * @param {object} opts
 * @param {string} opts.catalogName   shown so it is obvious where this lands
 * @param {boolean} [opts.hasLocation] false = opening stock can't be received
 * @param {string} [opts.locationName]
 * @param {function} opts.onSubmit    async (draft) => { ok, error?, message? }
 * @param {function} opts.onCancel
 */
export function renderProductForm({
  catalogName = "your catalog", hasLocation = true, locationName = "your warehouse",
  onSubmit = async () => ({ ok: true }), onCancel = () => {},
} = {}) {
  const el = document.createElement("section");
  el.className = "card detail-card product-form";

  el.innerHTML = `
    <header class="detail-card-head">
      <h3>New product</h3>
      <p>It goes into <strong>${esc(catalogName)}</strong> and appears in Inventory straight away${
        hasLocation ? `, at ${esc(locationName)}` : ""
      }.</p>
    </header>
  `;

  const body = document.createElement("div");
  body.className = "detail-card-body";
  el.appendChild(body);

  // ---- product-level fields ----
  const nameId = nextId(), descId = nextId(), catId = nextId(), modelId = nextId(), moqId = nextId();
  const head = document.createElement("div");
  head.className = "pf-grid";
  head.innerHTML = `
    <div class="pf-field pf-span-2">
      <label class="pf-label" for="${nameId}">Product name</label>
      <input class="input" id="${nameId}" placeholder="e.g. Merino Crew Knit" autocomplete="off">
      <p class="pf-error" data-for="${nameId}" hidden></p>
    </div>
    <div class="pf-field">
      <label class="pf-label" for="${catId}">Category</label>
      <input class="input" id="${catId}" placeholder="e.g. Knitwear" autocomplete="off">
    </div>
    <div class="pf-field">
      <label class="pf-label" for="${moqId}">Minimum order</label>
      <input class="input" id="${moqId}" type="number" min="1" step="1" value="1" inputmode="numeric">
      <p class="pf-hint">Fewest units a buyer may take of this product.</p>
    </div>
    <div class="pf-field pf-span-2">
      <label class="pf-label" for="${modelId}">How it sells</label>
      <select class="input" id="${modelId}">
        ${SELLING_MODELS.map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join("")}
      </select>
    </div>
    <div class="pf-field pf-span-2">
      <label class="pf-label" for="${descId}">Description <span class="pf-optional">optional</span></label>
      <textarea class="input" id="${descId}" rows="2" placeholder="What a buyer should know about it."></textarea>
    </div>
  `;
  body.appendChild(head);

  // ---- variants ----
  const vHead = document.createElement("div");
  vHead.className = "pf-section-head";
  vHead.innerHTML = `<h4>Variants</h4><p>One row per SKU — a colour and size combination you actually stock.</p>`;
  body.appendChild(vHead);

  const rows = document.createElement("div");
  rows.className = "pf-rows";
  body.appendChild(rows);

  function addRow(prefill = {}) {
    const row = document.createElement("div");
    row.className = "pf-row";
    const ids = { sku: nextId(), color: nextId(), size: nextId(), price: nextId(),
                  cost: nextId(), retail: nextId(), moq: nextId(), stock: nextId(), hex: nextId() };
    row.innerHTML = `
      <div class="pf-row-grid">
        <div class="pf-field">
          <label class="pf-label" for="${ids.sku}">SKU</label>
          <input class="input" id="${ids.sku}" data-k="sku" placeholder="MCK-BLK-M" autocomplete="off" value="${esc(prefill.sku || "")}">
          <p class="pf-error" data-for="${ids.sku}" hidden></p>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.color}">Colour</label>
          <input class="input" id="${ids.color}" data-k="color" placeholder="Black" autocomplete="off" value="${esc(prefill.color || "")}">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.size}">Size</label>
          <input class="input" id="${ids.size}" data-k="size" placeholder="M" autocomplete="off" value="${esc(prefill.size || "")}">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.price}">Wholesale price</label>
          <input class="input" id="${ids.price}" data-k="price" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(prefill.price || "")}">
          <p class="pf-error" data-for="${ids.price}" hidden></p>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.cost}">Your cost <span class="pf-optional">optional</span></label>
          <input class="input" id="${ids.cost}" data-k="cost" type="number" min="0" step="0.01" inputmode="decimal">
          <p class="pf-hint">Never shown to buyers.</p>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.retail}">Retail / RRP <span class="pf-optional">optional</span></label>
          <input class="input" id="${ids.retail}" data-k="retailPrice" type="number" min="0" step="0.01" inputmode="decimal">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.moq}">Min per SKU</label>
          <input class="input" id="${ids.moq}" data-k="moqQty" type="number" min="1" step="1" value="1" inputmode="numeric">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.stock}">Opening stock</label>
          <input class="input" id="${ids.stock}" data-k="openingStock" type="number" min="0" step="1" value="0" inputmode="numeric" ${hasLocation ? "" : "disabled"}>
          ${hasLocation ? "" : `<p class="pf-hint">No stock location set up yet.</p>`}
        </div>
      </div>
      <div class="pf-colorbar">
        <span class="pf-label">Swatch</span>
        <div class="pf-swatches" role="radiogroup" aria-label="Colour swatch"></div>
        <label class="pf-label pf-custom-label" for="${ids.hex}">Custom</label>
        <input type="color" class="pf-color-input" id="${ids.hex}" data-k="colorHex" value="#111827">
      </div>
    `;

    // Swatches. Buttons rather than radios so the 44px touch target is the
    // control itself -- Gate 6 measures the tappable box, and a styled radio's
    // hit area is the label, which is easy to get wrong by accident.
    const bar = row.querySelector(".pf-swatches");
    const hexInput = row.querySelector('[data-k="colorHex"]');
    const colorInput = row.querySelector('[data-k="color"]');
    SWATCHES.forEach(([label, hex]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pf-swatch";
      const dot = document.createElement("span");
      dot.className = "pf-swatch-dot";
      dot.style.background = hex;
      b.appendChild(dot);
      b.title = label;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => {
        hexInput.value = hex;
        // Fill the colour NAME unless the operator typed it themselves.
        //
        // "Only if blank" was the first attempt and it was wrong. Adding a
        // variant carries the previous row's colour down (because adding
        // S/M/L in one colour is the common case), so the field is rarely
        // blank -- and clicking the Red swatch on a row carrying "Black" left
        // a variant named Black with a red swatch. Caught by looking at the
        // screenshot: row two read "Black / L" with red selected.
        //
        // `typedColor` is set by the input's own listener below, so a name the
        // operator actually wrote ("Charcoal", "Off-white") is never
        // overwritten, while a carried-down one is.
        if (!colorInput.dataset.typed) colorInput.value = label;
        bar.querySelectorAll(".pf-swatch").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      });
      bar.appendChild(b);
    });

    // Once the operator types a colour name, swatches stop rewriting it.
    // Cleared again if they empty the field, so it can start auto-filling once
    // more rather than staying stuck.
    colorInput.addEventListener("input", () => {
      if (colorInput.value.trim()) colorInput.dataset.typed = "1";
      else delete colorInput.dataset.typed;
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-ghost btn-sm pf-remove";
    remove.textContent = "Remove this variant";
    remove.addEventListener("click", () => {
      if (rows.children.length === 1) return;   // never leave zero rows
      row.remove();
      syncRemoveButtons();
    });
    row.appendChild(remove);

    rows.appendChild(row);
    syncRemoveButtons();
    return row;
  }

  /** The last remaining row cannot be removed -- a product with no variants
   *  cannot be saved, so offering the button is offering a dead end. */
  function syncRemoveButtons() {
    const only = rows.children.length === 1;
    rows.querySelectorAll(".pf-remove").forEach((b) => { b.hidden = only; });
  }

  addRow();

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-secondary btn-sm pf-add";
  addBtn.textContent = "+ Add another variant";
  addBtn.addEventListener("click", () => {
    // Carries the colour down. Adding sizes S/M/L/XL in one colour is the
    // common case by a distance, and retyping the colour four times is the
    // sort of friction that makes people go back to the spreadsheet.
    const last = rows.lastElementChild;
    const row = addRow({ color: last?.querySelector('[data-k="color"]')?.value || "" });
    const lastHex = last?.querySelector('[data-k="colorHex"]')?.value;
    if (lastHex) row.querySelector('[data-k="colorHex"]').value = lastHex;
    row.querySelector('[data-k="sku"]').focus();
  });
  body.appendChild(addBtn);

  // ---- actions ----
  const status = document.createElement("p");
  status.className = "pf-status";
  status.setAttribute("role", "status");   // announced without stealing focus
  status.hidden = true;

  const actions = document.createElement("div");
  actions.className = "pf-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-primary";
  save.textContent = "Create product";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn-secondary";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", onCancel);
  actions.appendChild(save);
  actions.appendChild(cancel);
  body.appendChild(status);
  body.appendChild(actions);

  function showError(inputId, message) {
    const p = el.querySelector(`.pf-error[data-for="${inputId}"]`);
    if (!p) return;
    p.textContent = message;
    p.hidden = !message;
    const input = el.querySelector(`#${inputId}`);
    if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  }
  function clearErrors() {
    el.querySelectorAll(".pf-error").forEach((p) => { p.hidden = true; p.textContent = ""; });
    el.querySelectorAll("[aria-invalid]").forEach((i) => i.setAttribute("aria-invalid", "false"));
  }

  function readDraft() {
    const val = (id) => el.querySelector(`#${id}`).value;
    return {
      name: val(nameId).trim(),
      description: val(descId).trim(),
      category: val(catId).trim(),
      sellingModel: val(modelId),
      moqQty: Number(val(moqId)) || 1,
      variants: [...rows.children].map((row) => {
        const g = (k) => row.querySelector(`[data-k="${k}"]`)?.value ?? "";
        return {
          sku: g("sku").trim(), color: g("color").trim(), size: g("size").trim(),
          colorHex: g("colorHex"), price: g("price"), cost: g("cost"),
          retailPrice: g("retailPrice"), moqQty: Number(g("moqQty")) || 1,
          openingStock: Number(g("openingStock")) || 0,
          _skuId: row.querySelector('[data-k="sku"]').id,
          _priceId: row.querySelector('[data-k="price"]').id,
        };
      }),
    };
  }

  /** Returns true if the draft is sound. Messages sit next to the field they
   *  are about -- a single banner at the top means scrolling to find which of
   *  eight SKU boxes is the problem. */
  function validate(draft) {
    clearErrors();
    let firstBad = null;

    if (!draft.name) {
      showError(nameId, "Every product needs a name.");
      firstBad = firstBad || nameId;
    }

    const seen = new Map();
    draft.variants.forEach((v) => {
      if (!v.sku) {
        showError(v._skuId, "A SKU is required — it is how this variant is identified everywhere.");
        firstBad = firstBad || v._skuId;
        return;
      }
      const key = v.sku.toLowerCase();
      if (seen.has(key)) {
        showError(v._skuId, "This SKU is already used by another row.");
        firstBad = firstBad || v._skuId;
      }
      seen.set(key, true);

      // Price is checked but NOT required: a product can legitimately be set
      // up before its price is agreed. Zero is a real price (a free sample);
      // negative is not.
      if (v.price !== "" && Number(v.price) < 0) {
        showError(v._priceId, "A price cannot be negative.");
        firstBad = firstBad || v._priceId;
      }
    });

    if (firstBad) {
      const input = el.querySelector(`#${firstBad}`);
      input?.focus();
      input?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    return !firstBad;
  }

  save.addEventListener("click", async () => {
    const draft = readDraft();
    if (!validate(draft)) return;

    save.disabled = true;
    cancel.disabled = true;
    save.textContent = "Creating…";
    status.hidden = false;
    status.className = "pf-status";
    status.textContent = "Creating the product and its variants…";

    let result;
    try {
      result = await onSubmit(draft);
    } catch (err) {
      result = { ok: false, error: err?.message || "Something went wrong." };
    }

    save.disabled = false;
    cancel.disabled = false;
    save.textContent = "Create product";

    if (!result?.ok) {
      status.className = "pf-status pf-status-error";
      status.textContent = result?.error || "Could not create the product.";
      return;
    }
    status.className = "pf-status pf-status-ok";
    status.textContent = result.message || "Created.";
  });

  return {
    el,
    focus: () => el.querySelector(`#${nameId}`)?.focus(),
    reset: () => {
      el.querySelector(`#${nameId}`).value = "";
      el.querySelector(`#${descId}`).value = "";
      el.querySelector(`#${catId}`).value = "";
      rows.innerHTML = "";
      addRow();
      clearErrors();
      status.hidden = true;
    },
  };
}
