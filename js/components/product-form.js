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
import { renderScanBar } from "./scan-bar.js";
import { uniqueNameForHex } from "../lib/colour-names.js";

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
  suppliers = [], onCreateSupplier = null,
  // Batch 19: the same form reopened on an existing product. One component
  // for create and edit, because two forms for one object drift -- the edit
  // one always ends up missing the field the create one grew last week.
  initial = null,
  onSubmit = async () => ({ ok: true }), onCancel = () => {},
} = {}) {
  const isEdit = !!initial;
  // Back-compat: older callers passed hasLocation/locationName rather than the
  // list. Synthesising a single entry keeps them working unchanged.
  if (!locations.length && hasLocation) locations = [{ id: null, name: locationName || "your warehouse", is_default: true }];

  // ---- state ----
  const photos = [];            // { file, url, id }
  const colours = [];           // { id, name, hex, photoId|null, sizes:[], cells:{size:{qty,sku,barcode}} }
  let defaultSizes = SIZE_PRESETS["S–XL"].slice();

  const el = document.createElement("section");
  el.className = "card detail-card product-form product-builder";

  const ids = {
    name: nid(), cat: nid(), desc: nid(), model: nid(), moq: nid(),
    price: nid(), cost: nid(), retail: nid(), loc: nid(), sizes: nid(),
    supplier: nid(), supName: nid(), supContact: nid(), supPhone: nid(),
    supEmail: nid(), supAddress: nid(), supCountry: nid(), supRef: nid(), supNotes: nid(),
    supSells: nid(), supBrands: nid(), supMoq: nid(), supLead: nid(), supTerms: nid(),
    supCurrency: nid(), supSite: nid(), supWhats: nid(), supInsta: nid(), supCatalog: nid(),
    barcode: nid(),
  };
  // Mutable so a supplier created inline can join the list without a reload.
  let supplierList = suppliers.slice();

  el.innerHTML = `
    <header class="detail-card-head">
      <h3>${isEdit ? "Edit product" : "New product"}</h3>
      <p>${isEdit
        ? "Change anything here and save. Removing a colour or size that already holds stock or sits on a past order is refused — that would rewrite what your orders say they contained."
        : `Photos, then colours, then sizes. It goes into <strong>${esc(catalogName)}</strong> and appears in Inventory straight away.`}</p>
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
      <div class="pf-field pf-span-2 pb-product-barcode">
        <label class="pf-label" for="${ids.barcode}">Barcode for the whole product <span class="pf-optional">optional</span></label>
        <div class="pb-cell-bc">
          <input class="input" id="${ids.barcode}" autocomplete="off" placeholder="One code for every colour and size">
          <button type="button" class="btn btn-secondary btn-sm" data-scan-product>Scan</button>
        </div>
        <p class="pf-hint">Use this if one code covers the entire style. You can also give each colour its own, and each size its own — fill in whichever levels your labels actually use.</p>
        <p class="pf-error" data-for="${ids.barcode}" hidden></p>
      </div>

      <div class="pb-scan" id="pb-scan"></div>
      <div class="pb-grid" id="pb-grid"></div>

      <div class="pf-section-head"><h4>Supplier <span class="pf-optional">optional</span></h4>
        <p>Who you buy this from. Pick one you already have, or add a new one without leaving this form.</p></div>
      <div class="pb-supplier" id="pb-supplier"></div>

      <p class="pf-status" role="status" hidden></p>
      <div class="pf-actions">
        <button type="button" class="btn btn-primary" id="pb-save">${isEdit ? "Save changes" : "Create product"}</button>
        <button type="button" class="btn btn-secondary" id="pb-cancel">Cancel</button>
      </div>
    </div>
  `;

  const $ = (s) => el.querySelector(s);
  const photosHost = $("#pb-photos");
  const coloursHost = $("#pb-colours");
  const sizesHost = $("#pb-sizes");
  const gridHost = $("#pb-grid");
  const supplierHost = $("#pb-supplier");
  const scanHost = $("#pb-scan");
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
      // Tapping a photo opens the colour picker on THAT photo. Picking colours
      // is what these thumbnails are for; reordering is the rarer act, so it
      // gets its own button below rather than owning the whole tile.
      cell.addEventListener("click", () => openColourPicker({ startPhotoId: p.id }));

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

      if (i !== 0) {
        const main = document.createElement("button");
        main.type = "button";
        main.className = "pb-photo-main";
        main.textContent = "Make main";
        main.addEventListener("click", (ev) => {
          ev.stopPropagation();          // do not also open the picker
          const [moved] = photos.splice(i, 1);
          photos.unshift(moved);
          paintPhotos(); paintColours();
        });
        cell.appendChild(main);
      }

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
  }

  // =========================================================================
  // THE COLOUR PICKER
  // =========================================================================
  // Hadi: "when I click on pick from photo... nothing. What we did last time is
  // the actual image of the products appears in front of me, expands to take
  // over most of the screen, and I can with my finger click on any colour in
  // the image and extract that colour. And I can switch between different
  // images so I can pick every colour that I want. Every click is a colour."
  //
  // That is the whole specification and it is worth taking literally:
  //
  //   THE PHOTO GETS THE SCREEN. Sampling a colour off a garment means hitting
  //   a specific few pixels -- a cuff, a stripe, the body away from a fold.
  //   The old flow asked for that on a 90px thumbnail, which is not a
  //   precision instrument, and gave no visible response to the button press
  //   at all. It did not fail; it just never looked like it had started.
  //
  //   IT STAYS OPEN. "Every click is a colour" means a run of taps, not one
  //   tap and a dismissal. Closing after each pick would make a six-colour
  //   product six trips through the same modal.
  //
  //   IMAGES SWITCH INSIDE IT. Colourways usually live across several photos,
  //   so having to close, change photo and reopen would break the run.
  //
  // The live chip under the finger is not decoration. A fingertip is roughly
  // 40px across and completely covers the pixel it is aiming at, so without a
  // readout the person literally cannot see what they are about to pick. It
  // shows the colour and its name before the tap commits anything.
  function openColourPicker({ forColourId = null, startPhotoId = null } = {}) {
    if (!photos.length) {
      showError("photos", "Add a photo first — there is nothing to pick a colour from.");
      photosHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return null;
    }

    // Start on the photo this colour already came from, if it has one, so
    // re-picking a colour opens where it was found rather than at photo 1.
    const existing = colours.find((c) => c.id === forColourId);
    const openOn = startPhotoId || existing?.photoId || null;
    let index = Math.max(0, photos.findIndex((p) => p.id === openOn));
    let target = forColourId;          // cleared after the first tap
    const pickedIds = [];

    const overlay = document.createElement("div");
    overlay.className = "pb-picker";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Pick colours from photo");
    overlay.innerHTML = `
      <div class="pb-picker-bar">
        <span class="pb-picker-title">Tap the photo to pick a colour</span>
        <span class="pb-picker-live" data-live>
          <i class="pb-picker-chip" data-live-chip></i>
          <span data-live-name>—</span>
        </span>
        <button type="button" class="btn btn-primary btn-sm" data-done>Done</button>
      </div>
      <div class="pb-picker-stage"><canvas data-stage></canvas></div>
      <div class="pb-picker-picked" data-picked></div>
      <div class="pb-picker-strip" data-strip></div>
    `;

    const canvas = overlay.querySelector("[data-stage]");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const liveChip = overlay.querySelector("[data-live-chip]");
    const liveName = overlay.querySelector("[data-live-name]");
    const pickedHost = overlay.querySelector("[data-picked]");
    const stripHost = overlay.querySelector("[data-strip]");

    // A 12MP phone photo would otherwise become a 4000x3000 canvas held in
    // memory on the device least able to afford it. Colour is unaffected by
    // downscaling; only the long edge is capped.
    const MAX_EDGE = 1600;

    function drawPhoto() {
      const photo = photos[index];
      if (!photo) return;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.onerror = () => {
        // Blocked or unreadable image: say so in the picker rather than
        // leaving a blank rectangle that reads as "the app is broken".
        liveName.textContent = "This photo could not be read";
      };
      img.src = photo.url;
    }

    function hexAt(ev) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const x = Math.floor((ev.clientX - rect.left) * (canvas.width / rect.width));
      const y = Math.floor((ev.clientY - rect.top) * (canvas.height / rect.height));
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
      try {
        const d = ctx.getImageData(x, y, 1, 1).data;
        // A fully transparent pixel reports as black, which would silently add
        // a wrong colour. Treat it as "nothing here" instead.
        if (d[3] === 0) return null;
        return "#" + [d[0], d[1], d[2]].map((n) => ("0" + n.toString(16)).slice(-2)).join("");
      } catch {
        return null;
      }
    }

    function paintPicked() {
      pickedHost.innerHTML = "";
      if (!pickedIds.length) {
        pickedHost.innerHTML = `<span class="pb-picker-empty">Every tap adds a colour. Switch photos below to keep going.</span>`;
        return;
      }
      pickedIds.forEach((id) => {
        const c = colours.find((x) => x.id === id);
        if (!c) return;
        const chip = document.createElement("span");
        chip.className = "pb-picker-picked-chip";
        chip.innerHTML = `<i style="background:${esc(c.hex)}"></i><span>${esc(c.name || "Unnamed")}</span>`;
        const undo = document.createElement("button");
        undo.type = "button";
        undo.className = "pb-picker-undo";
        undo.setAttribute("aria-label", `Remove ${c.name || "this colour"}`);
        undo.textContent = "×";
        // Undo has to be here, inside the picker. A mis-tap on a shadow is the
        // most likely thing to go wrong in a fast run of picks, and making
        // someone close the modal to delete it would end the run.
        undo.addEventListener("click", () => {
          const at = colours.findIndex((x) => x.id === id);
          if (at >= 0) colours.splice(at, 1);
          pickedIds.splice(pickedIds.indexOf(id), 1);
          paintPicked();
          paintColours(); paintGrid();
        });
        chip.appendChild(undo);
        pickedHost.appendChild(chip);
      });
    }

    function paintStrip() {
      stripHost.innerHTML = "";
      if (photos.length < 2) return;
      photos.forEach((p, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pb-picker-thumb" + (i === index ? " is-active" : "");
        b.setAttribute("aria-label", `Photo ${i + 1}`);
        b.setAttribute("aria-pressed", String(i === index));
        b.innerHTML = `<img src="${p.url}" alt="">`;
        b.addEventListener("click", () => { index = i; drawPhoto(); paintStrip(); });
        stripHost.appendChild(b);
      });
    }

    function preview(ev) {
      const hex = hexAt(ev);
      if (!hex) return;
      liveChip.style.background = hex;
      liveName.textContent = `${uniqueNameForHex(hex, []) || "Colour"} · ${hex.toUpperCase()}`;
    }

    function commit(ev) {
      const hex = hexAt(ev);
      if (!hex) return;
      const taken = colours.map((c) => c.name);
      const name = uniqueNameForHex(hex, taken) || "";
      const photoId = photos[index]?.id || null;

      if (target) {
        // The first tap fills the colour whose button opened this. After that,
        // every further tap adds a NEW colour -- "every click is a colour".
        const c = colours.find((x) => x.id === target);
        if (c) {
          c.hex = hex;
          c.photoId = photoId;
          // Only name it if the wholesaler has not written their own name.
          // Overwriting a name someone typed would be the app arguing with the
          // person who knows what the colour is actually called.
          if (!c.nameTyped) c.name = name;
          if (!pickedIds.includes(c.id)) pickedIds.push(c.id);
        }
        target = null;
      } else {
        const c = addColour({ hex, photoId, name });
        pickedIds.push(c.id);
      }
      paintPicked();
      paintColours(); paintGrid();
    }

    canvas.addEventListener("pointermove", preview);
    canvas.addEventListener("pointerdown", (ev) => { ev.preventDefault(); preview(ev); commit(ev); });

    function close() {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      overlay.remove();
      paintPhotos(); paintColours(); paintGrid();
    }
    function onKey(ev) { if (ev.key === "Escape") close(); }

    overlay.querySelector("[data-done]").addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";   // the page must not scroll under the picker
    document.body.appendChild(overlay);
    drawPhoto(); paintStrip(); paintPicked();
    return overlay;
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
    // paintGrid() is NOT optional here. Without it a new colour appeared in the
    // colour list with no row in the stock grid, and the grid only caught up
    // when something ELSE happened to repaint it -- typing in any name field
    // did, which is why this looked fine to whoever added a colour and then
    // named it, and looked broken to Hadi, who added several and then went
    // looking for the matrix. The check missed it for the same reason: it
    // typed a name after every colour, so its own ordering repainted the grid
    // and hid the gap.
    paintColours(); paintGrid();
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
        // A name the wholesaler typed outranks any name the app worked out.
        // Clearing the box hands naming back to the picker, which is the
        // natural way to say "you choose" -- so this is not a one-way latch.
        c.nameTyped = ev.target.value.trim() !== "";
        paintGrid();   // the grid's row labels follow the name as it is typed
      });

      const tools = document.createElement("div");
      tools.className = "pb-colour-tools";

      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "btn btn-secondary btn-sm pb-eye";
      eye.textContent = "Pick from photo";
      // Opens the photo full-screen and sets THIS colour from the next tap.
      // The old behaviour armed a mode and then waited for a tap on a 90px
      // thumbnail in the strip above, with the only feedback a line of text --
      // which on a phone is indistinguishable from the button doing nothing.
      eye.addEventListener("click", () => openColourPicker({ forColourId: c.id }));
      tools.appendChild(eye);

      const hex = document.createElement("input");
      hex.type = "color";
      hex.className = "pf-color-input";
      hex.value = /^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : "#111827";
      hex.setAttribute("aria-label", `Colour value for ${c.name || "this colour"}`);
      hex.addEventListener("input", () => {
        c.hex = hex.value;
        // The grid header carries this colour's dot, so it goes stale too.
        paintColours(); paintGrid();
      });
      tools.appendChild(hex);

      // btn-danger-quiet, not btn-ghost. Hadi looked straight at this row and
      // reported "there is no remove button" -- and he was right about the
      // thing that matters: a ghost button is text with no border and no fill,
      // so next to a real bordered button it reads as a caption rather than
      // something you can press. It was 77x30 and perfectly visible, which is
      // exactly why "it renders" is not the same as "it is findable". The
      // symbol makes it scannable without reading, and the wording stays
      // explicit for screen readers.
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-danger-quiet btn-sm pb-colour-del";
      del.innerHTML = `<span aria-hidden="true">🗑</span> Remove`;
      del.setAttribute("aria-label", `Remove colour ${c.name || idx + 1}`);
      del.title = "Remove this colour";
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

    // The primary way in: open the photo big and take as many colours off it
    // as the product has. Listed first because on a product with photos it is
    // the faster path by a wide margin -- one modal, N taps, N named colours,
    // versus N rounds of "add colour, open picker, tap, close".
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "btn btn-primary btn-sm";
    pickBtn.textContent = "Pick colours from photo";
    pickBtn.addEventListener("click", () => openColourPicker({}));
    add.appendChild(pickBtn);

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

  // =========================================================================
  // SUPPLIER
  // =========================================================================
  // Hadi asked to be able to create a supplier "here in the inventory and in
  // the catalogs whenever we create an actual product". So the picker carries
  // its own create form: leaving a half-built product to go and make a supplier
  // means either losing the product or juggling two screens, and this form
  // holds unsaved photos and a grid that cannot survive a navigation.
  //
  // Optional, and it says so. A wholesaler who does not track sourcing must not
  // be blocked from saving a product, which is also why supplier_id is nullable
  // in migration 050.
  let selectedSupplierId = "";
  let supplierFormOpen = false;

  function paintSupplier() {
    supplierHost.innerHTML = "";

    const row = document.createElement("div");
    row.className = "pb-supplier-row";

    const sel = document.createElement("select");
    sel.className = "input";
    sel.id = ids.supplier;
    sel.setAttribute("aria-label", "Supplier for this product");
    sel.innerHTML =
      `<option value="">No supplier</option>` +
      supplierList.map((sp) => `<option value="${esc(sp.id)}"${sp.id === selectedSupplierId ? " selected" : ""}>${esc(sp.name)}</option>`).join("");
    sel.addEventListener("change", () => { selectedSupplierId = sel.value; paintSupplier(); });
    row.appendChild(sel);

    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "btn btn-secondary btn-sm";
    newBtn.textContent = supplierFormOpen ? "Cancel new supplier" : "+ New supplier";
    newBtn.addEventListener("click", () => { supplierFormOpen = !supplierFormOpen; paintSupplier(); });
    row.appendChild(newBtn);
    supplierHost.appendChild(row);

    // Show what was chosen. A bare select says the name and nothing else, and
    // the reason to record a supplier at all is to be able to reach them.
    const chosen = supplierList.find((sp) => sp.id === selectedSupplierId);
    if (chosen && !supplierFormOpen) {
      const card = document.createElement("div");
      card.className = "pb-supplier-card";
      const bits = [
        chosen.contactName && `Contact: ${chosen.contactName}`,
        chosen.phone,
        chosen.email,
        [chosen.address, chosen.country].filter(Boolean).join(", "),
        chosen.refCode && `Ref ${chosen.refCode}`,
      ].filter(Boolean);
      card.innerHTML = bits.length
        ? bits.map((b) => `<span>${esc(b)}</span>`).join("")
        : `<span class="pf-hint">No contact details recorded for this supplier yet.</span>`;
      supplierHost.appendChild(card);
    }

    if (!supplierFormOpen) return;

    const form = document.createElement("div");
    form.className = "pb-supplier-new pf-grid";
    form.innerHTML = `
      <div class="pf-field pf-span-2">
        <label class="pf-label" for="${ids.supName}">Supplier name <span class="pf-required">required</span></label>
        <input class="input" id="${ids.supName}" autocomplete="off" placeholder="e.g. Zhejiang Textiles">
        <p class="pf-error" data-for="${ids.supName}" hidden></p>
      </div>
      <div class="pf-field">
        <label class="pf-label" for="${ids.supContact}">Contact person <span class="pf-required">required</span></label>
        <input class="input" id="${ids.supContact}" autocomplete="off">
      </div>
      <div class="pf-field">
        <label class="pf-label" for="${ids.supPhone}">Phone <span class="pf-required">required</span></label>
        <input class="input" id="${ids.supPhone}" type="tel" autocomplete="off">
      </div>
      <div class="pf-field">
        <label class="pf-label" for="${ids.supEmail}">Email</label>
        <input class="input" id="${ids.supEmail}" type="email" autocomplete="off">
      </div>
      <div class="pf-field">
        <label class="pf-label" for="${ids.supCountry}">Country</label>
        <input class="input" id="${ids.supCountry}" autocomplete="off">
      </div>
      <div class="pf-field pf-span-2">
        <label class="pf-label" for="${ids.supAddress}">Address <span class="pf-required">required</span></label>
        <input class="input" id="${ids.supAddress}" autocomplete="off">
      </div>
      <div class="pf-field pf-span-2">
        <label class="pf-label" for="${ids.supSells}">What they sell <span class="pf-optional">optional</span></label>
        <input class="input" id="${ids.supSells}" autocomplete="off" placeholder="Denim, knitwear, outerwear — separate with commas">
      </div>
      <div class="pf-field pf-span-2">
        <label class="pf-label" for="${ids.supBrands}">Brands they carry <span class="pf-optional">optional</span></label>
        <input class="input" id="${ids.supBrands}" autocomplete="off" placeholder="Separate with commas">
      </div>
      <div class="pf-field">
        <label class="pf-label" for="${ids.supRef}">Your reference <span class="pf-optional">optional</span></label>
        <input class="input" id="${ids.supRef}" autocomplete="off">
      </div>
      <div class="pf-field pf-span-2">
        <label class="pf-label" for="${ids.supNotes}">Notes <span class="pf-optional">optional</span></label>
        <input class="input" id="${ids.supNotes}" autocomplete="off">
      </div>
      <p class="pf-hint pf-span-2">Trade terms, links and your own rating live on the Suppliers screen — this form keeps to what you need right now so you can get back to the product.</p>
    `;
    supplierHost.appendChild(form);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-primary btn-sm";
    saveBtn.textContent = "Save supplier";
    saveBtn.addEventListener("click", async () => {
      const val = (k) => el.querySelector(`#${ids[k]}`)?.value || "";
      // The same four required fields the Suppliers screen enforces, named all
      // at once rather than one refusal at a time.
      const missing = [];
      if (!val("supName").trim()) missing.push(["name", ids.supName]);
      if (!val("supContact").trim()) missing.push(["contact person", ids.supContact]);
      if (!val("supPhone").trim()) missing.push(["phone", ids.supPhone]);
      if (!val("supAddress").trim() && !val("supCountry").trim()) missing.push(["location", ids.supAddress]);
      if (missing.length) {
        const words = missing.map((m) => m[0]);
        const list = words.length === 1
          ? words[0]
          : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
        showError(ids.supName, `A supplier needs a ${list}.`);
        el.querySelector(`#${missing[0][1]}`)?.focus();
        return;
      }
      if (typeof onCreateSupplier !== "function") {
        showError(ids.supName, "Suppliers cannot be created from here yet.");
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      const res = await onCreateSupplier({
        name: val("supName"), contactName: val("supContact"), phone: val("supPhone"),
        email: val("supEmail"), address: val("supAddress"), country: val("supCountry"),
        refCode: val("supRef"), notes: val("supNotes"),
        sells: val("supSells"), brands: val("supBrands"),
      });
      saveBtn.disabled = false;
      saveBtn.textContent = "Save supplier";
      if (!res?.ok) {
        // The database's own message, which names the real reason -- "you
        // already have a supplier called X" tells them to pick it instead.
        showError(ids.supName, res?.error || "Could not save that supplier.");
        return;
      }
      supplierList = supplierList.concat([res.supplier]).sort((a, b) => a.name.localeCompare(b.name));
      selectedSupplierId = res.supplier.id;   // created it, so it is the one they meant
      supplierFormOpen = false;
      paintSupplier();
    });

    const actions = document.createElement("div");
    actions.className = "pb-supplier-actions";
    actions.appendChild(saveBtn);
    supplierHost.appendChild(actions);
  }

  // =========================================================================
  // SCANNING INTO THE GRID
  // =========================================================================
  // A cell is a colour+size, and the barcode belongs to that exact pair, so
  // "where does this scan go?" has to have one unambiguous answer at all
  // times. That answer is the AIMED cell, shown in words next to the scan bar
  // -- a scanner fires instantly and a code landing in an invisible or guessed
  // place is worse than no scanning at all.
  //
  // After a successful scan the aim advances to the next cell (next size, then
  // the first size of the next colour), which is what makes a run of scans
  // possible without touching the screen between them -- the same reason the
  // warehouse scan bar refocuses itself. It stops at the last cell rather than
  // wrapping: wrapping would quietly overwrite the first barcode with the last
  // scan, and an operator watching the label gun would not see it happen.
  // The aim now has a KIND, because there are three barcode tiers and a scan
  // has to land on exactly one of them. Guessing which level a code belongs to
  // is not possible from the code itself -- an EAN-13 for a whole style looks
  // identical to one for a single size -- so the operator points first and the
  // scan follows the pointer.
  let scanAim = null;      // { kind: "cell"|"colour"|"product", cid?, size? }
  let scanBarRef = null;   // the live scan bar, so a cell button can hand it focus

  function aimScanner(cid, size) {
    scanAim = { kind: "cell", cid, size };
    paintScanAim();
  }

  function aimColourScanner(cid) {
    scanAim = { kind: "colour", cid };
    paintScanAim();
  }

  function aimProductScanner() {
    scanAim = { kind: "product" };
    paintScanAim();
  }

  /** Every barcode currently on the form, across all three tiers, as
   *  { code, where } -- so a duplicate can be refused with the place it
   *  already lives rather than a bare "already used". */
  function allBarcodes() {
    const out = [];
    const prod = el.querySelector(`#${ids.barcode}`)?.value.trim();
    if (prod) out.push({ code: prod, where: "the whole product", kind: "product" });
    colours.forEach((c) => {
      if (c.barcode) out.push({ code: c.barcode, where: `${c.name || "a colour"} (whole colourway)`, kind: "colour", cid: c.id });
      c.sizes.forEach((size) => {
        const bc = c.cells[size]?.barcode;
        if (bc) out.push({ code: bc, where: `${c.name || "a colour"} · ${size}`, kind: "cell", cid: c.id, size });
      });
    });
    return out;
  }

  function cellSequence() {
    const seq = [];
    colours.forEach((c) => c.sizes.forEach((size) => seq.push({ cid: c.id, size })));
    return seq;
  }

  function paintScanAim() {
    const label = scanHost.querySelector("[data-scan-aim]");
    if (!label) return;
    const c = colours.find((x) => x.id === scanAim?.cid);
    if (!scanAim) label.textContent = "pick a cell first";
    else if (scanAim.kind === "product") label.textContent = "the whole product";
    else if (scanAim.kind === "colour") label.textContent = `${c?.name || "Unnamed colour"} — whole colourway`;
    else label.textContent = `${c?.name || "Unnamed colour"} · ${scanAim.size}`;

    gridHost.querySelectorAll(".pb-cell").forEach((n) => n.classList.remove("pb-cell-aimed"));
    gridHost.querySelectorAll(".pb-colour-barcode").forEach((n) => n.classList.remove("pb-aimed-field"));
    el.querySelector(`#${ids.barcode}`)?.classList.remove("pb-aimed-field");

    if (!scanAim) return;
    if (scanAim.kind === "product") {
      el.querySelector(`#${ids.barcode}`)?.classList.add("pb-aimed-field");
    } else if (scanAim.kind === "colour") {
      gridHost.querySelector(`[data-colour-barcode="${scanAim.cid}"]`)?.classList.add("pb-aimed-field");
    } else {
      const node = gridHost.querySelector(`[data-barcode-for="${scanAim.cid}|${scanAim.size}"]`);
      node?.closest(".pb-cell")?.classList.add("pb-cell-aimed");
    }
  }

  function applyScan(code) {
    const value = String(code || "").trim();
    if (!value) return;
    if (!scanAim) {
      setStatus("Tap the barcode box you are scanning into first, so the code has somewhere to go.", true);
      return;
    }

    // A barcode identifies exactly one thing, at exactly one level. The same
    // code on a colour AND on a size inside it would make a scan ambiguous in
    // the warehouse, which is the failure the tiers exist to avoid -- so the
    // clash is checked across ALL THREE tiers, not within one.
    const clash = allBarcodes().find((b) => {
      if (b.code.toLowerCase() !== value.toLowerCase()) return false;
      if (scanAim.kind === "product") return b.kind !== "product";
      if (scanAim.kind === "colour") return !(b.kind === "colour" && b.cid === scanAim.cid);
      return !(b.kind === "cell" && b.cid === scanAim.cid && b.size === scanAim.size);
    });
    if (clash) {
      setStatus(`${value} is already on ${clash.where}. Each barcode belongs to one thing.`, true);
      return;
    }

    if (scanAim.kind === "product") {
      const field = el.querySelector(`#${ids.barcode}`);
      if (field) field.value = value;
      setStatus(`${value} → the whole product.`, false);
      paintScanAim();
      return;
    }

    const c = colours.find((x) => x.id === scanAim.cid);
    if (!c) {
      setStatus("That colour is gone. Pick a barcode box and scan again.", true);
      scanAim = null; paintScanAim();
      return;
    }

    if (scanAim.kind === "colour") {
      c.barcode = value;
      const field = gridHost.querySelector(`[data-colour-barcode="${c.id}"]`);
      if (field) field.value = value;
      setStatus(`${value} → every size in ${c.name || "this colour"}.`, false);
      paintScanAim();
      return;
    }

    if (!c.sizes.includes(scanAim.size)) {
      // The aimed cell can disappear underneath the operator if the size list
      // was edited between scans. Refusing is right; silently retargeting
      // would put the code on a different garment than the one in their hand.
      setStatus("That cell is gone — the sizes changed. Tap a cell and scan again.", true);
      scanAim = null; paintScanAim();
      return;
    }

    c.cells[scanAim.size] = c.cells[scanAim.size] || { qty: 0, sku: "", barcode: "" };
    c.cells[scanAim.size].barcode = value;
    const field = gridHost.querySelector(`[data-barcode-for="${scanAim.cid}|${scanAim.size}"]`);
    if (field) field.value = value;

    const seq = cellSequence();
    const at = seq.findIndex((x) => x.cid === scanAim.cid && x.size === scanAim.size);
    const next = at >= 0 ? seq[at + 1] : null;
    setStatus(
      next
        ? `${value} → ${c.name || "colour"} · ${scanAim.size}. Next: ${(colours.find((x) => x.id === next.cid)?.name) || "colour"} · ${next.size}.`
        : `${value} → ${c.name || "colour"} · ${scanAim.size}. That was the last cell.`,
      false
    );
    if (next) {
      scanAim = { kind: "cell", cid: next.cid, size: next.size };
      const nc = colours.find((x) => x.id === next.cid);
      scanBarRef?.setPlaceholder(`Scan for ${nc?.name || "colour"} · ${next.size}…`);
    }
    paintScanAim();
  }

  function setStatus(text, isProblem) {
    const line = scanHost.querySelector("[data-scan-status]");
    if (!line) return;
    line.textContent = text;
    line.classList.toggle("pf-error-text", !!isProblem);
  }

  function paintScanner() {
    scanHost.innerHTML = "";
    if (!colours.length) return;

    const head = document.createElement("div");
    head.className = "pb-scan-head";
    head.innerHTML = `<span class="pf-label">Barcodes</span>
      <span class="pb-scan-aim">Scanning into: <strong data-scan-aim>pick a cell first</strong></span>`;
    scanHost.appendChild(head);

    // autofocus is off here: in the warehouse the operator's next act is
    // always another scan, but this bar sits in the middle of a form someone
    // is still typing into, and stealing focus would fight them.
    const bar = renderScanBar({
      placeholder: "Scan a barcode, or type it and press Enter…",
      onSubmit: applyScan,
      autofocus: false,
      compact: true,
    });
    scanBarRef = bar;
    scanHost.appendChild(bar.el);

    const line = document.createElement("p");
    line.className = "pf-hint";
    line.setAttribute("data-scan-status", "");
    line.textContent = "Optional. A hardware scanner types the code and presses Enter, so it just works here.";
    scanHost.appendChild(line);

    paintScanAim();
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
      // Starts a run at this colour's first size. Each scan advances to the
      // next size on its own, so a colour with six sizes is one button press
      // and six trigger pulls rather than twelve alternating actions.
      const cbWrap = document.createElement("div");
      cbWrap.className = "pb-colour-bc";
      const cbLabel = document.createElement("span");
      cbLabel.className = "pf-label";
      cbLabel.textContent = "Barcode for this colour";
      const cbInput = document.createElement("input");
      cbInput.className = "input pb-colour-barcode";
      cbInput.autocomplete = "off";
      cbInput.placeholder = "Covers every size in this colour";
      cbInput.value = c.barcode || "";
      cbInput.dataset.colourBarcode = c.id;
      cbInput.setAttribute("aria-label", `Barcode for ${c.name || "this colour"}`);
      cbInput.addEventListener("input", () => { c.barcode = cbInput.value.trim(); });
      cbInput.addEventListener("focus", () => aimColourScanner(c.id));
      const cbScan = document.createElement("button");
      cbScan.type = "button";
      cbScan.className = "btn btn-secondary btn-xs";
      cbScan.textContent = "Scan";
      cbScan.dataset.scanColour = c.id;
      cbScan.setAttribute("aria-label", `Scan the barcode for ${c.name || "this colour"}`);
      cbScan.addEventListener("click", () => {
        aimColourScanner(c.id);
        scanBarRef?.setPlaceholder(`Scan for the whole ${c.name || "colour"} colourway…`);
        scanBarRef?.refocus();
        scanHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      const cbRow = document.createElement("div");
      cbRow.className = "pb-cell-bc";
      cbRow.appendChild(cbInput);
      cbRow.appendChild(cbScan);
      cbWrap.appendChild(cbLabel);
      cbWrap.appendChild(cbRow);

      const runBtn = document.createElement("button");
      runBtn.type = "button";
      runBtn.className = "btn btn-secondary btn-xs pb-grid-scanall";
      runBtn.textContent = "Scan sizes";
      runBtn.dataset.scanRun = c.id;
      runBtn.setAttribute("aria-label", `Scan barcodes for every size of ${c.name || "this colour"}`);
      runBtn.addEventListener("click", () => {
        if (!c.sizes.length) return;
        aimScanner(c.id, c.sizes[0]);
        scanBarRef?.setPlaceholder(`Scan for ${c.name || "colour"} · ${c.sizes[0]}…`);
        scanBarRef?.refocus();
        scanHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      head.appendChild(runBtn);
      block.appendChild(head);
      block.appendChild(cbWrap);

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
        // On CREATE this is opening stock. On EDIT it is not editable, and
        // saying so is the point.
        //
        // Stock only ever moves through receive/adjust/transfer RPCs -- the
        // architecture rule is that nothing writes v2_inventory_balances
        // directly, so a number typed here on an existing product had no path
        // to the database and was silently dropped on save. A box that accepts
        // a number and discards it is worse than no box: the operator watches
        // themselves type 40, clicks Save, is told it saved, and finds 0.
        if (isEdit) {
          const held = document.createElement("span");
          held.className = "pb-cell-onhand";
          const n = c.cells[size]?.qty ?? 0;
          held.textContent = `${n} on hand`;
          held.title = "Stock moves through Receive & transfer, not here — so this cannot be edited from the product form.";
          cell.appendChild(held);
        } else {
          const qty = document.createElement("input");
          qty.className = "input";
          qty.type = "number";
          qty.min = "0";
          qty.step = "1";
          qty.inputMode = "numeric";
          qty.id = inputId;
          qty.value = String(c.cells[size]?.qty ?? 0);
          qty.setAttribute("aria-label", `${c.name || "colour"} ${size} opening quantity`);
          qty.addEventListener("input", () => {
            c.cells[size] = c.cells[size] || { qty: 0, sku: "", barcode: "" };
            c.cells[size].qty = Math.max(0, parseInt(qty.value, 10) || 0);
            updateTotal(c);
          });
          qty.addEventListener("focus", () => aimScanner(c.id, size));
          cell.appendChild(qty);
        }

        // The barcode that will be printed on THIS colour+size. It is a
        // separate field from the code/SKU on purpose (migration 016): a SKU
        // is the wholesaler's own readable identifier, a barcode is whatever
        // the UPC/EAN label actually carries, and they are usually different
        // strings. Typing here works; scanning fills it without typing.
        const bc = document.createElement("input");
        bc.className = "input pb-cell-barcode";
        bc.type = "text";
        bc.autocomplete = "off";
        bc.placeholder = "Barcode";
        bc.value = c.cells[size]?.barcode || "";
        bc.dataset.barcodeFor = `${c.id}|${size}`;
        bc.setAttribute("aria-label", `${c.name || "colour"} ${size} barcode`);
        bc.addEventListener("input", () => {
          c.cells[size] = c.cells[size] || { qty: 0, sku: "", barcode: "" };
          c.cells[size].barcode = bc.value.trim();
        });
        bc.addEventListener("focus", () => aimScanner(c.id, size));

        const bcRow = document.createElement("div");
        bcRow.className = "pb-cell-bc";
        bcRow.appendChild(bc);

        // Hadi asked for a scan button on each barcode box. It aims at THIS
        // cell and hands focus to the scan bar, which is what a hardware
        // scanner needs -- those devices type into whatever is focused and
        // press Enter, so "focus the right field" IS the whole integration.
        // The camera path, where the browser has one, lives on the scan bar's
        // own button rather than being duplicated 30 times down the grid.
        const scanBtn = document.createElement("button");
        scanBtn.type = "button";
        scanBtn.className = "btn btn-secondary btn-xs pb-cell-scan";
        scanBtn.textContent = "Scan";
        scanBtn.dataset.scanFor = `${c.id}|${size}`;
        scanBtn.setAttribute("aria-label", `Scan a barcode for ${c.name || "this colour"} ${size}`);
        scanBtn.addEventListener("click", () => {
          aimScanner(c.id, size);
          scanBarRef?.setPlaceholder(`Scan for ${c.name || "colour"} · ${size}…`);
          scanBarRef?.refocus();
          scanHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
        bcRow.appendChild(scanBtn);
        cell.appendChild(bcRow);

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

    // The grid is rebuilt wholesale on every change, so the aim has to be
    // re-checked against what now exists rather than assumed to still be valid.
    if (scanAim?.kind === "cell" &&
        !colours.find((x) => x.id === scanAim.cid && x.sizes.includes(scanAim.size))) {
      scanAim = null;
    }
    if (scanAim?.kind === "colour" && !colours.find((x) => x.id === scanAim.cid)) {
      scanAim = null;
    }
    paintScanner();
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
      // Only NEWLY picked files. In edit mode the strip also holds photos that
      // are already in storage; they have a url and no File, and handing a
      // null to the uploader would fail a save for a photo that is fine.
      photos: photos.filter((p) => p.file).map((p) => p.file),
      // The WHOLE strip, in the order it is on screen: existing photos keep
      // their url, new ones carry the File. Creating a product only needs the
      // new files above, but editing one needs the order and the deletions
      // too -- "Make main" and the × button were doing nothing on save,
      // because a list of new files cannot express "this one was removed" or
      // "these two swapped places".
      photoStrip: photos.map((p) => (p.file ? { file: p.file } : { url: p.url })),
      supplierId: selectedSupplierId || null,
      barcode: v(ids.barcode).trim(),
      colourBarcodes: colours
        .filter((c) => (c.barcode || "").trim())
        .map((c) => ({ color: c.name.trim(), barcode: c.barcode.trim() })),
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
    // applyScan already refuses a duplicate at the moment it is scanned, but a
    // barcode can also be TYPED straight into a cell, which never goes through
    // applyScan. The database has a unique index on barcode (migration 016), so
    // without this the save reaches Postgres and comes back as a constraint
    // violation naming neither of the two cells involved.
    const seenCodes = new Map();
    const codeDupes = new Set();
    draft.variants.forEach((x) => {
      const code = (x.barcode || "").trim().toLowerCase();
      if (!code) return;
      if (seenCodes.has(code)) codeDupes.add(x.barcode.trim());
      seenCodes.set(code, `${x.color} · ${x.size}`);
    });
    if (codeDupes.size) {
      showError("colours", `Barcode ${[...codeDupes][0]} is on more than one variant. Each barcode belongs to exactly one colour and size.`);
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

  el.querySelector("[data-scan-product]")?.addEventListener("click", () => {
    aimProductScanner();
    scanBarRef?.setPlaceholder("Scan the code for the whole product…");
    scanBarRef?.refocus();
    scanHost.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  // ---- edit mode: fill the form from the product it was opened on --------
  if (isEdit) {
    const set = (idKey, value) => {
      const node = el.querySelector(`#${ids[idKey]}`);
      if (node != null && value != null) node.value = value;
    };
    set("name", initial.name);
    set("desc", initial.description || "");
    set("cat", initial.category || "");
    set("moq", initial.moqQty || 1);
    set("model", initial.sellingModel || "open");
    set("barcode", initial.barcode || "");
    // Product-level price/cost/retail are shown from the FIRST variant,
    // because that is where the create form puts them -- they are a
    // convenience spread across variants, not a column on the product.
    const first = (initial.variants || [])[0] || {};
    set("price", first.price ?? "");
    set("cost", first.cost ?? "");
    set("retail", first.retailPrice ?? "");

    selectedSupplierId = initial.supplierId || "";

    // Existing photos are shown as already-uploaded, distinct from newly
    // picked files: they have a url but no File, so the save path must not
    // try to re-upload them.
    (initial.images || []).forEach((url) => {
      photos.push({ file: null, url, id: nid(), existing: true });
    });

    // Rebuild colours and the grid from the variants.
    const byColour = new Map();
    (initial.variants || []).forEach((v) => {
      const cname = (v.color || "").trim();
      if (!cname) return;
      let c = byColour.get(cname.toLowerCase());
      if (!c) {
        c = {
          id: nid(), name: cname, hex: v.colorHex || "#111827",
          photoId: null, sizes: [], cells: {},
          nameTyped: true,     // a name that already shipped is not a guess
          custom: true,        // its sizes are its own, not the shared run
          barcode: (initial.colourBarcodes || {})[cname.toLowerCase()] || "",
        };
        byColour.set(cname.toLowerCase(), c);
        colours.push(c);
      }
      const size = (v.size || "").trim();
      if (!size) return;
      if (!c.sizes.includes(size)) c.sizes.push(size);
      c.cells[size] = {
        qty: Number(v.onHand) || 0,
        sku: v.sku || "",
        barcode: v.barcode || "",
        variantId: v.id,
      };
    });
  }

  paintPhotos();
  paintColours();
  paintSupplier();
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
