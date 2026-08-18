// =============================================================================
// OGGI Wholesale v2 — PRODUCT BUILDER
// =============================================================================
//
// Rewritten 18 Aug 2026, after Hadi looked at the first version and said it
// was "way too primitive" compared to what the old build had. He was right,
// and the old code proved it: deploy-2026-07-25/index.html has multi-photo
// upload, an eyedropper that samples a colour off a photo, and a colour x size
// stock grid. The grid was built, reviewed three times, had 11 real bugs found
// and fixed -- and was never deployed, which is why v2 never inherited it.
// (The live v1 is 412,116 bytes; that deploy record states the grid took it
// from 412,116 to 424,901. The live site is byte-for-byte the pre-grid build.)
//
// WHAT THIS IS
// ------------
// One form, still, used by BOTH the catalog builder and Inventory -- they
// differ by whether a catalog id comes along. Two copies would drift, quietly,
// exactly as the ten copies of the escape helper and seven of pageHeader
// already have.
//
// The shape of the entry changed completely, though. Instead of a flat list of
// variants where the operator retypes the colour on every row, it is now:
//
//     photos  ->  colours (named, sampled from the photos)  ->  sizes  ->  grid
//
// and every filled cell in that grid becomes one variant. Six colours in five
// sizes is 30 variants from one screen, not 30 rows typed by hand.
//
// PER-COLOUR SIZE RUNS COST NOTHING HERE, AND THAT IS NOT AN ACCIDENT
// ------------------------------------------------------------------
// v1 held stock as a keyed blob ("Blue|40") inside the product, so its grid had
// to be a rectangle -- every colour got every size column. Its own record lists
// per-colour size vocabularies as NOT built for that reason.
//
// In v2 a cell is simply a variant ROW. Nothing requires Blue and Black to
// have the same sizes: you create the rows that exist and skip the ones that
// do not. So "Blue in 38-42, Black in 36-46" needs no schema change at all --
// only this screen. Each colour therefore carries its own size list, seeded
// from a shared default so the common case stays one decision.
//
// The v1 backlog note said it best and the rule is kept: the grid must make
// the exception cheap, not the rule expensive.
//
// TWO BEHAVIOURS COPIED DELIBERATELY FROM THE v1 CODE
// ---------------------------------------------------
//   * Changing a size list CARRIES FORWARD every cell whose size name is
//     unchanged. Renaming or removing one size loses only its own cells, never
//     another colour's and never another size's.
//   * It NEVER auto-splits a quantity across sizes. v1's comment: "that's the
//     wholesaler's call." Guessing here silently invents stock figures.
//
// PHOTOS STAY LOCAL UNTIL SAVE
// ----------------------------
// uploadProductImage() needs a product id, and the product does not exist
// while someone is still choosing colours. So photos are held as Files with
// object URLs and uploaded once the product row exists. That also makes the
// eyedropper instant -- it samples a local bitmap, with no round trip.
//
// PRICING IS DELIBERATELY PRODUCT-LEVEL HERE
// ------------------------------------------
// One price/cost/retail applied to every cell. Per-variant pricing already has
// a home -- the Pricing & MOQ panel on the Products screen -- and duplicating
// it into 30 grid cells would make the fast path slow to serve a case that is
// already covered. Stated rather than hidden, because it is a real limit.
// =============================================================================

import { esc } from "../lib/utils.js";

/** A small palette for products with no photos yet. The eyedropper is the
 *  real answer; this is the fallback, not the feature. */
const SWATCHES = [
  ["Black", "#111827"], ["White", "#FFFFFF"], ["Grey", "#9CA3AF"],
  ["Navy", "#1E3A5F"], ["Blue", "#2563EB"], ["Sky", "#7DD3FC"],
  ["Green", "#15803D"], ["Olive", "#4D7C0F"], ["Mint", "#54E5A0"],
  ["Red", "#B91C1C"], ["Burgundy", "#7F1D1D"], ["Pink", "#EC4899"],
  ["Orange", "#EA580C"], ["Mustard", "#CA8A04"], ["Cream", "#F5E9D3"],
  ["Beige", "#D6C3A5"], ["Brown", "#78350F"], ["Purple", "#7C3AED"],
];

const SIZE_PRESETS = {
  "S–XL":    ["S", "M", "L", "XL"],
  "XS–XXL":  ["XS", "S", "M", "L", "XL", "XXL"],
  "36–46":   ["36", "38", "40", "42", "44", "46"],
  "One size": ["One size"],
};

const SELLING_MODELS = [
  ["open", "Open — buyers pick any quantity of any variant"],
  ["prepack", "Prepack — sold as fixed bundles"],
  ["series", "Series — sold as a full size run"],
  ["ratio", "Ratio — sized to a fixed curve"],
];

let uid = 0;
const nid = () => `pb-${++uid}`;

/** SKU-safe token: "Merino Crew" -> "MER", "Off White" -> "OFF". */
function tok(s, n = 3) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, n) || "X";
}

/**
 * @param {object} opts
 * @param {string} opts.catalogName
 * @param {Array}  [opts.locations]   [{id, name, is_default}]
 * @param {function} opts.onSubmit    async (draft) => { ok, error?, message? }
 * @param {function} opts.onCancel
 */
export function renderProductForm({
  catalogName = "your catalog", locations = [], hasLocation = true, locationName = "",
  onSubmit = async () => ({ ok: true }), onCancel = () => {},
} = {}) {
  // Back-compat: older callers passed hasLocation/locationName rather than the
  // list. Synthesising a single entry keeps them working unchanged.
  if (!locations.length && hasLocation) locations = [{ id: null, name: locationName || "your warehouse", is_default: true }];

  // ---- state ----
  const photos = [];            // { file, url, id }
  const colours = [];           // { id, name, hex, photoId|null, sizes:[], cells:{size:{qty,sku,barcode}} }
  let defaultSizes = SIZE_PRESETS["S–XL"].slice();
  let eyedropperFor = null;     // colour id currently sampling

  const el = document.createElement("section");
  el.className = "card detail-card product-form product-builder";

  const ids = {
    name: nid(), cat: nid(), desc: nid(), model: nid(), moq: nid(),
    price: nid(), cost: nid(), retail: nid(), loc: nid(), sizes: nid(),
  };

  el.innerHTML = `
    <header class="detail-card-head">
      <h3>New product</h3>
      <p>Photos, then colours, then sizes. It goes into <strong>${esc(catalogName)}</strong> and appears in Inventory straight away.</p>
    </header>
    <div class="detail-card-body">
      <div class="pf-grid">
        <div class="pf-field pf-span-2">
          <label class="pf-label" for="${ids.name}">Product name</label>
          <input class="input" id="${ids.name}" placeholder="e.g. Merino Crew Knit" autocomplete="off">
          <p class="pf-error" data-for="${ids.name}" hidden></p>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.cat}">Category</label>
          <input class="input" id="${ids.cat}" placeholder="e.g. Knitwear" autocomplete="off">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.moq}">Minimum order</label>
          <input class="input" id="${ids.moq}" type="number" min="1" step="1" value="1" inputmode="numeric">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.price}">Wholesale price</label>
          <input class="input" id="${ids.price}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00">
          <p class="pf-hint">Applies to every colour and size.</p>
          <p class="pf-error" data-for="${ids.price}" hidden></p>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.cost}">Your cost <span class="pf-optional">optional</span></label>
          <input class="input" id="${ids.cost}" type="number" min="0" step="0.01" inputmode="decimal">
          <p class="pf-hint">Never shown to buyers.</p>
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.retail}">Retail / RRP <span class="pf-optional">optional</span></label>
          <input class="input" id="${ids.retail}" type="number" min="0" step="0.01" inputmode="decimal">
        </div>
        <div class="pf-field">
          <label class="pf-label" for="${ids.loc}">Stock goes to</label>
          <select class="input" id="${ids.loc}">
            ${locations.map((l) => `<option value="${esc(l.id || "")}">${esc(l.name)}${l.is_default ? " (default)" : ""}</option>`).join("")}
          </select>
        </div>
        <div class="pf-field pf-span-2">
          <label class="pf-label" for="${ids.model}">How it sells</label>
          <select class="input" id="${ids.model}">
            ${SELLING_MODELS.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("")}
          </select>
        </div>
        <div class="pf-field pf-span-2">
          <label class="pf-label" for="${ids.desc}">Description <span class="pf-optional">optional</span></label>
          <textarea class="input" id="${ids.desc}" rows="2" placeholder="What a buyer should know about it."></textarea>
        </div>
      </div>

      <div class="pf-section-head"><h4>Photos</h4>
        <p>Add photos first — you can tap one to pick a colour straight off the fabric.</p></div>
      <div class="pb-photos" id="pb-photos"></div>
      <p class="pf-error" data-for="photos" hidden></p>

      <div class="pf-section-head"><h4>Colours</h4>
        <p>Name each one. Tap a photo to sample its colour, or pick from the palette.</p></div>
      <div class="pb-colours" id="pb-colours"></div>
      <p class="pf-error" data-for="colours" hidden></p>

      <div class="pf-section-head"><h4>Sizes and stock</h4>
        <p>Set the sizes once; any colour that differs can have its own.</p></div>
      <div class="pb-sizes" id="pb-sizes"></div>
      <div class="pb-grid" id="pb-grid"></div>

      <p class="pf-status" role="status" hidden></p>
      <div class="pf-actions">
        <button type="button" class="btn btn-primary" id="pb-save">Create product</button>
        <button type="button" class="btn btn-secondary" id="pb-cancel">Cancel</button>
      </div>
    </div>
  `;

  const $ = (s) => el.querySelector(s);
  const photosHost = $("#pb-photos");
  const coloursHost = $("#pb-colours");
  const sizesHost = $("#pb-sizes");
  const gridHost = $("#pb-grid");
  const status = $(".pf-status");

  // =========================================================================
  // PHOTOS
  // =========================================================================
  function paintPhotos() {
    photosHost.innerHTML = "";

    photos.forEach((p, i) => {
      const cell = document.createElement("div");
      cell.className = "pb-photo";
      cell.innerHTML = `
        <img src="${p.url}" alt="Product photo ${i + 1}">
        ${i === 0 ? '<span class="pb-photo-primary">Main</span>' : ""}
      `;
      // Tapping a photo is how a colour gets sampled -- so the whole tile is
      // the target, not a tiny icon on it.
      cell.addEventListener("click", (ev) => {
        if (eyedropperFor) { sampleFromPhoto(p, ev, cell.querySelector("img")); return; }
        // No eyedropper armed: promote to main.
        const [moved] = photos.splice(i, 1);
        photos.unshift(moved);
        paintPhotos(); paintColours();
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "pb-photo-del";
      del.setAttribute("aria-label", `Remove photo ${i + 1}`);
      del.textContent = "×";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        photos.splice(i, 1);
        // A colour that pointed at this photo keeps its colour and loses only
        // the reference. Dropping the colour too would throw away naming work
        // for something the operator did not ask to delete.
        colours.forEach((c) => { if (c.photoId === p.id) c.photoId = null; });
        paintPhotos(); paintColours();
      });
      cell.appendChild(del);
      photosHost.appendChild(cell);
    });

    const add = document.createElement("label");
    add.className = "pb-photo pb-photo-add";
    add.innerHTML = `<span>+ Add photos</span><input type="file" accept="image/*" multiple hidden>`;
    add.querySelector("input").addEventListener("change", (ev) => {
      [...ev.target.files].forEach((file) => {
        if (!file.type.startsWith("image/")) return;
        photos.push({ file, url: URL.createObjectURL(file), id: nid() });
      });
      ev.target.value = "";
      paintPhotos(); paintColours();
    });
    photosHost.appendChild(add);

    if (eyedropperFor) {
      const hint = document.createElement("p");
      hint.className = "pb-eyedrop-hint";
      const c = colours.find((x) => x.id === eyedropperFor);
      hint.textContent = photos.length
        ? `Tap anywhere on a photo to set the colour for "${c?.name || "this colour"}".`
        : "Add a photo first — there is nothing to sample from yet.";
      photosHost.appendChild(hint);
    }
  }

  /** Samples the tapped pixel. Canvas + getImageData, no library, so the CSP
   *  (`script-src 'self'`) is untouched -- the same approach v1 used. */
  function sampleFromPhoto(photo, ev, imgEl) {
    const rect = imgEl.getBoundingClientRect();
    const cv = document.createElement("canvas");
    cv.width = imgEl.naturalWidth || rect.width;
    cv.height = imgEl.naturalHeight || rect.height;
    const ctx = cv.getContext("2d");
    try {
      ctx.drawImage(imgEl, 0, 0, cv.width, cv.height);
      const x = Math.floor((ev.clientX - rect.left) * (cv.width / rect.width));
      const y = Math.floor((ev.clientY - rect.top) * (cv.height / rect.height));
      const d = ctx.getImageData(
        Math.max(0, Math.min(cv.width - 1, x)),
        Math.max(0, Math.min(cv.height - 1, y)), 1, 1
      ).data;
      const hex = "#" + [d[0], d[1], d[2]].map((n) => ("0" + n.toString(16)).slice(-2)).join("");
      const c = colours.find((x) => x.id === eyedropperFor);
      if (c) { c.hex = hex; c.photoId = photo.id; }
    } catch {
      showError("photos", "Could not read that photo's colours. Try a different image.");
    }
    eyedropperFor = null;
    paintPhotos(); paintColours();
  }

  // =========================================================================
  // COLOURS
  // =========================================================================
  function addColour(prefill = {}) {
    const c = {
      id: nid(),
      // Deliberately blank, not "Colour 1". Hadi asked to name each colour
      // AFTER picking it, and a prefilled placeholder is the thing people
      // forget to replace -- the catalogue then ships with "Colour 3" on it.
      name: prefill.name || "",
      hex: prefill.hex || "#111827",
      photoId: prefill.photoId || null,
      sizes: defaultSizes.slice(),
      cells: {},
    };
    colours.push(c);
    paintColours();
    // Focus the name box: naming is the next thing to do.
    setTimeout(() => el.querySelector(`[data-colour-name="${c.id}"]`)?.focus(), 0);
    return c;
  }

  function paintColours() {
    coloursHost.innerHTML = "";

    colours.forEach((c, idx) => {
      const row = document.createElement("div");
      row.className = "pb-colour";
      const photo = photos.find((p) => p.id === c.photoId);
      row.innerHTML = `
        <span class="pb-colour-dot" style="background:${esc(c.hex)}"></span>
        <input class="input pb-colour-name" data-colour-name="${c.id}"
               value="${esc(c.name)}" placeholder="Name this colour" autocomplete="off"
               aria-label="Name for colour ${idx + 1}">
        ${photo ? `<img class="pb-colour-photo" src="${photo.url}" alt="">` : ""}
      `;

      row.querySelector(".pb-colour-name").addEventListener("input", (ev) => {
        c.name = ev.target.value;
        paintGrid();   // the grid's row labels follow the name as it is typed
      });

      const tools = document.createElement("div");
      tools.className = "pb-colour-tools";

      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "btn btn-secondary btn-sm pb-eye";
      eye.textContent = eyedropperFor === c.id ? "Tap a photo…" : "Pick from photo";
      eye.setAttribute("aria-pressed", String(eyedropperFor === c.id));
      eye.addEventListener("click", () => {
        eyedropperFor = eyedropperFor === c.id ? null : c.id;
        paintPhotos(); paintColours();
        if (eyedropperFor) photosHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      tools.appendChild(eye);

      const hex = document.createElement("input");
      hex.type = "color";
      hex.className = "pf-color-input";
      hex.value = /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : "#111827";
      hex.setAttribute("aria-label", `Colour value for ${c.name || "this colour"}`);
      hex.addEventListener("input", () => { c.hex = hex.value; paintColours(); });
      tools.appendChild(hex);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-sm";
      del.textContent = "Remove";
      del.addEventListener("click", () => {
        colours.splice(idx, 1);
        paintColours(); paintGrid();
      });
      tools.appendChild(del);

      row.appendChild(tools);
      coloursHost.appendChild(row);
    });

    const add = document.createElement("div");
    add.className = "pb-colour-add";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn btn-secondary btn-sm";
    addBtn.textContent = "+ Add colour";
    addBtn.addEventListener("click", () => addColour());
    add.appendChild(addBtn);

    // The palette stays as a fallback for products with no photos.
    const pal = document.createElement("div");
    pal.className = "pf-swatches";
    SWATCHES.forEach(([label, hexv]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pf-swatch";
      const dot = document.createElement("span");
      dot.className = "pf-swatch-dot";
      dot.style.background = hexv;
      b.appendChild(dot);
      b.title = `Add ${label}`;
      b.setAttribute("aria-label", `Add ${label}`);
      b.addEventListener("click", () => addColour({ name: label, hex: hexv }));
      pal.appendChild(b);
    });
    add.appendChild(pal);
    coloursHost.appendChild(add);
  }

  // =========================================================================
  // SIZES + GRID
  // =========================================================================
  function paintSizes() {
    sizesHost.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "pb-size-presets";
    Object.keys(SIZE_PRESETS).forEach((k) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-secondary btn-sm";
      b.textContent = k;
      b.addEventListener("click", () => {
        defaultSizes = SIZE_PRESETS[k].slice();
        // Only colours still on the previous default follow along. One that
        // was given its own run keeps it -- changing the preset must not
        // silently undo a per-colour decision.
        colours.forEach((c) => { if (!c.custom) { c.sizes = defaultSizes.slice(); reconcile(c); } });
        paintSizes(); paintGrid();
      });
      wrap.appendChild(b);
    });
    sizesHost.appendChild(wrap);

    const field = document.createElement("div");
    field.className = "pf-field";
    field.innerHTML = `
      <label class="pf-label" for="${ids.sizes}">Sizes, comma separated</label>
      <input class="input" id="${ids.sizes}" value="${esc(defaultSizes.join(", "))}" autocomplete="off">
      <p class="pf-hint">Applies to every colour that has not been given its own.</p>
    `;
    field.querySelector("input").addEventListener("change", (ev) => {
      defaultSizes = parseSizes(ev.target.value);
      colours.forEach((c) => { if (!c.custom) { c.sizes = defaultSizes.slice(); reconcile(c); } });
      paintGrid();
    });
    sizesHost.appendChild(field);
  }

  const parseSizes = (s) =>
    String(s || "").split(",").map((x) => x.trim()).filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);

  /**
   * Reshapes a colour's cells after its size list changes.
   *
   * Copied from v1's onEpSizesChange, whose comment is worth keeping: every
   * cell whose size NAME is unchanged carries forward; renamed or removed
   * sizes lose only their own cells, never another colour's and never another
   * size's. Rebuilding from scratch here would silently zero typed-in stock.
   */
  function reconcile(c) {
    const next = {};
    c.sizes.forEach((s) => { next[s] = c.cells[s] || { qty: 0, sku: "", barcode: "" }; });
    c.cells = next;
  }

  function autoSku(c, size) {
    const base = tok(el.querySelector(`#${ids.name}`).value, 3);
    return `${base}-${tok(c.name, 3)}-${tok(size, 3)}`;
  }

  function paintGrid() {
    gridHost.innerHTML = "";
    if (!colours.length) {
      const p = document.createElement("p");
      p.className = "pf-hint";
      p.textContent = "Add a colour and the stock grid appears here.";
      gridHost.appendChild(p);
      return;
    }

    colours.forEach((c) => {
      reconcile(c);
      const block = document.createElement("div");
      block.className = "pb-grid-row";

      const head = document.createElement("div");
      head.className = "pb-grid-head";
      head.innerHTML = `
        <span class="pb-colour-dot" style="background:${esc(c.hex)}"></span>
        <strong>${esc(c.name || "Unnamed colour")}</strong>
        <span class="pb-grid-total" data-total="${c.id}">0</span>
      `;
      block.appendChild(head);

      const sizeField = document.createElement("div");
      sizeField.className = "pb-grid-sizes";
      const sizeInput = document.createElement("input");
      sizeInput.className = "input";
      sizeInput.value = c.sizes.join(", ");
      sizeInput.setAttribute("aria-label", `Sizes for ${c.name || "this colour"}`);
      sizeInput.addEventListener("change", () => {
        c.sizes = parseSizes(sizeInput.value);
        // Marking it custom is what stops a later preset click wiping it.
        c.custom = c.sizes.join(",") !== defaultSizes.join(",");
        reconcile(c);
        paintGrid();
      });
      const lbl = document.createElement("span");
      lbl.className = "pf-label";
      lbl.textContent = "Sizes";
      sizeField.appendChild(lbl);
      sizeField.appendChild(sizeInput);
      block.appendChild(sizeField);

      const cells = document.createElement("div");
      cells.className = "pb-cells";
      c.sizes.forEach((size) => {
        const cell = document.createElement("label");
        cell.className = "pb-cell";
        const inputId = nid();
        cell.innerHTML = `<span class="pb-cell-size">${esc(size)}</span>`;
        const qty = document.createElement("input");
        qty.className = "input";
        qty.type = "number";
        qty.min = "0";
        qty.step = "1";
        qty.inputMode = "numeric";
        qty.id = inputId;
        qty.value = String(c.cells[size]?.qty ?? 0);
        qty.setAttribute("aria-label", `${c.name || "colour"} ${size} quantity`);
        qty.addEventListener("input", () => {
          c.cells[size] = c.cells[size] || { qty: 0, sku: "", barcode: "" };
          c.cells[size].qty = Math.max(0, parseInt(qty.value, 10) || 0);
          updateTotal(c);
        });
        cell.appendChild(qty);
        cells.appendChild(cell);
      });
      block.appendChild(cells);
      gridHost.appendChild(block);
      updateTotal(c);
    });

    const note = document.createElement("p");
    note.className = "pf-hint";
    note.textContent =
      "Every size you list becomes a variant, whether or not it has stock. Leave a size out of a colour if you do not carry it.";
    gridHost.appendChild(note);
  }

  function updateTotal(c) {
    const t = Object.values(c.cells).reduce((a, v) => a + (v.qty || 0), 0);
    const node = el.querySelector(`[data-total="${c.id}"]`);
    if (node) node.textContent = `${t} unit${t === 1 ? "" : "s"}`;
  }

  // =========================================================================
  // VALIDATE + SUBMIT
  // =========================================================================
  function showError(key, message) {
    const p = el.querySelector(`.pf-error[data-for="${key}"]`);
    if (!p) return;
    p.textContent = message;
    p.hidden = !message;
  }
  function clearErrors() {
    el.querySelectorAll(".pf-error").forEach((p) => { p.hidden = true; p.textContent = ""; });
  }

  /** Flattens the grid into the flat variant list createProduct already takes.
   *  The grid is an ENTRY SURFACE, not a second data model -- one shape all
   *  the way to the database. */
  function toVariants() {
    const out = [];
    colours.forEach((c) => {
      c.sizes.forEach((size) => {
        const cell = c.cells[size] || { qty: 0 };
        out.push({
          sku: (cell.sku || autoSku(c, size)).trim(),
          color: c.name.trim(),
          colorHex: c.hex,
          size,
          barcode: cell.barcode || "",
          openingStock: cell.qty || 0,
        });
      });
    });
    return out;
  }

  function readDraft() {
    const v = (id) => el.querySelector(`#${id}`).value;
    const variants = toVariants();
    const price = v(ids.price), cost = v(ids.cost), retail = v(ids.retail);
    return {
      name: v(ids.name).trim(),
      description: v(ids.desc).trim(),
      category: v(ids.cat).trim(),
      sellingModel: v(ids.model),
      moqQty: Number(v(ids.moq)) || 1,
      locationId: v(ids.loc) || null,
      photos: photos.map((p) => p.file),
      // Product-level pricing spread onto every variant -- see the header.
      variants: variants.map((x) => ({ ...x, price, cost, retailPrice: retail, moqQty: 1 })),
    };
  }

  function validate(draft) {
    clearErrors();
    let bad = null;
    if (!draft.name) { showError(ids.name, "Every product needs a name."); bad = ids.name; }
    if (!colours.length) {
      showError("colours", "Add at least one colour — that is what the grid is built from.");
      bad = bad || "colours";
    }
    const unnamed = colours.filter((c) => !c.name.trim());
    if (unnamed.length) {
      showError("colours", `Name ${unnamed.length === 1 ? "the colour" : `all ${unnamed.length} colours`} before saving — buyers see these names.`);
      bad = bad || "colours";
      el.querySelector(`[data-colour-name="${unnamed[0].id}"]`)?.focus();
    }
    const dupes = new Set();
    const seen = new Set();
    draft.variants.forEach((x) => {
      const k = x.sku.toLowerCase();
      if (seen.has(k)) dupes.add(x.sku);
      seen.add(k);
    });
    if (dupes.size) {
      showError("colours", `Two variants ended up with the same code (${[...dupes][0]}). Rename a colour or a size so they differ.`);
      bad = bad || "colours";
    }
    if (draft.variants.length === 0) {
      showError("colours", "No sizes listed, so there is nothing to create.");
      bad = bad || "colours";
    }
    if (draft.variants[0]?.price !== "" && Number(draft.variants[0]?.price) < 0) {
      showError(ids.price, "A price cannot be negative."); bad = bad || ids.price;
    }
    if (bad && el.querySelector(`#${bad}`)) {
      el.querySelector(`#${bad}`).focus();
      el.querySelector(`#${bad}`).scrollIntoView({ block: "center", behavior: "smooth" });
    }
    return !bad;
  }

  $("#pb-cancel").addEventListener("click", onCancel);
  $("#pb-save").addEventListener("click", async () => {
    const draft = readDraft();
    if (!validate(draft)) return;

    const save = $("#pb-save");
    save.disabled = true;
    save.textContent = "Creating…";
    status.hidden = false;
    status.className = "pf-status";
    status.textContent = draft.photos.length
      ? `Creating ${draft.variants.length} variants and uploading ${draft.photos.length} photo${draft.photos.length === 1 ? "" : "s"}…`
      : `Creating ${draft.variants.length} variants…`;

    let result;
    try {
      result = await onSubmit({ ...draft, onProgress: (m) => { status.textContent = m; } });
    } catch (err) {
      result = { ok: false, error: err?.message || "Something went wrong." };
    }

    save.disabled = false;
    save.textContent = "Create product";
    if (!result?.ok) {
      status.className = "pf-status pf-status-error";
      status.textContent = result?.error || "Could not create the product.";
      return;
    }
    status.className = "pf-status pf-status-ok";
    status.textContent = result.message || "Created.";
  });

  paintPhotos();
  paintColours();
  paintSizes();
  paintGrid();

  return {
    el,
    focus: () => el.querySelector(`#${ids.name}`)?.focus(),
    reset: () => {
      photos.splice(0).forEach((p) => URL.revokeObjectURL(p.url));
      colours.splice(0);
      el.querySelector(`#${ids.name}`).value = "";
      el.querySelector(`#${ids.desc}`).value = "";
      el.querySelector(`#${ids.cat}`).value = "";
      clearErrors();
      status.hidden = true;
      paintPhotos(); paintColours(); paintGrid();
    },
  };
}
