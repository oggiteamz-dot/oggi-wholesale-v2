// =============================================================================
// CHECK: every control the EDIT form shows actually reaches the save
// =============================================================================
// Hadi: "I'm making edits, but it's not actually editing. Like I click save and
// it reverts back to the original."
//
// He was right, and the write path was fine. The name, category, prices,
// barcodes and colours all saved correctly. What did not save was everything
// updateProduct never looked at:
//
//   - PHOTOS. The strip let him add, delete and "Make main", and
//     updateProduct did not read draft.photos at all. Saved, said so,
//     discarded all of it.
//   - QUANTITY. Every grid cell had a number box, prefilled with what was on
//     hand. Stock only moves through the receive/adjust/transfer RPCs -- so a
//     number typed there had no path to the database and was dropped.
//
// Both are the same defect wearing two hats: a control on screen that the save
// path ignores. That is worse than a missing feature, because the operator
// watches themselves make the change and is then told it worked.
//
// So this check does not test "photos save". It tests the RULE: mount the real
// edit form, list every control it offers, and require each one to be either
// carried in the draft or not editable in the first place.
//
//   node checks/check_edit_saves_what_it_shows.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://app.test/" });
for (const k of ["window", "document", "HTMLElement", "HTMLInputElement", "Node", "Event", "CustomEvent",
                 "getComputedStyle", "File", "FileList", "Blob", "DataTransfer"]) {
  if (dom.window[k] === undefined) continue;
  try { globalThis[k] = dom.window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
}
globalThis.URL.createObjectURL = () => "blob:stub";
globalThis.URL.revokeObjectURL = () => {};
if (!dom.window.HTMLCanvasElement.prototype.getContext) {
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
}

const { renderProductForm } = await import("../js/components/product-form.js");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

const initial = {
  name: "Heavyweight Tee",
  description: "240gsm",
  category: "T-shirts",
  moqQty: 12,
  sellingModel: "open",
  barcode: "5012345678900",
  supplierId: null,
  images: ["https://cdn.test/a.webp", "https://cdn.test/b.webp"],
  colourBarcodes: { crimson: "5012345678917" },
  variants: [
    { id: "v1", sku: "TEE-CRI-M", price: 18.5, cost: 7.25, retailPrice: 45, moqQty: 6,
      barcode: "5012345678924", color: "Crimson", size: "M", colorHex: "#B91C1C", onHand: 40 },
    { id: "v2", sku: "TEE-CRI-L", price: 18.5, cost: 7.25, retailPrice: 45, moqQty: 6,
      barcode: "", color: "Crimson", size: "L", colorHex: "#B91C1C", onHand: 0 },
  ],
};

let captured = null;
const form = renderProductForm({
  suppliers: [], locations: [], initial,
  onCancel: () => {},
  onSubmit: async (draft) => { captured = draft; return { ok: true, message: "saved" }; },
});
document.body.appendChild(form.el);

ok(!!form.el.querySelector("#pb-save"), "the edit form mounts");
ok(form.el.querySelector("#pb-save").textContent === "Save changes",
   "and its button says Save changes, not Create product");

// ---- the quantity box must not exist on an existing product ---------------
const qtyBoxes = [...form.el.querySelectorAll(".pb-cell input[type=number]")];
ok(qtyBoxes.length === 0,
  `no editable quantity box in the grid (${qtyBoxes.length} found) — stock moves through Receive & transfer, and a box that accepts a number and drops it is worse than no box`);
ok(form.el.querySelectorAll(".pb-cell-onhand").length === 2,
  "each cell states what is on hand instead");
ok(/40 on hand/.test(form.el.textContent), "and states the real figure, not zero");

// ---- the photo strip must survive the save --------------------------------
ok(form.el.querySelectorAll(".pb-photo img").length === 2,
  "both existing photos are on the strip");

form.el.querySelector("#pb-save").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));

ok(!!captured, "clicking save produces a draft");
ok(Array.isArray(captured?.photoStrip),
  "the draft carries the whole photo strip, not only newly picked files");
ok(captured?.photoStrip?.length === 2 &&
   captured.photoStrip[0].url === "https://cdn.test/a.webp" &&
   captured.photoStrip[1].url === "https://cdn.test/b.webp",
   `in the order they are on screen (${JSON.stringify(captured?.photoStrip)})`);

// ---- deleting a photo must be expressible ---------------------------------
// This is what a list of new files could never say. "Make main" has the same
// problem: it changes nothing about which files are new, only their order.
const del = form.el.querySelector(".pb-photo .pb-photo-del");
del.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
captured = null;
form.el.querySelector("#pb-save").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await new Promise((r) => setTimeout(r, 60));
ok(captured?.photoStrip?.length === 1 && captured.photoStrip[0].url === "https://cdn.test/b.webp",
  `removing a photo is carried through to the save (${JSON.stringify(captured?.photoStrip)})`);

// ---- and the save path must actually consume it ---------------------------
// The form can hand over a perfect strip and still change nothing if the other
// side ignores it, which is exactly the state this check was written for.
const admin = readFileSync("js/data/products-admin.js", "utf8");
const updateBody = admin.slice(admin.indexOf("export async function updateProduct"));
ok(/draft\.photoStrip/.test(updateBody),
  "updateProduct reads the photo strip");
ok(/uploadProductImage/.test(updateBody),
  "and uploads the new files in it");
// CR-0004, 25 Aug 2026 — this assertion was WEAKENED BY ITS OWN SHAPE and has
// been rewritten rather than deleted.
//
// It used to grep updateProduct's own source slice for `image_url` and
// `images:`. When the gallery write moved into the shared attachPhotos()
// helper -- so that create and edit could stop disagreeing about how photos
// are attached -- this went red while the BEHAVIOUR was strictly better. A
// check that fails on a refactor and would also pass on a dead `import` is
// measuring text, not truth.
//
// It now follows the indirection: updateProduct must hand off to attachPhotos,
// and attachPhotos must be the thing that writes the gallery. The behavioural
// proof -- that editing actually results in the right urls on the right
// variants -- lives in checks/check_colour_photos.mjs, Part D, which runs the
// real save path against a recording client and reads what was written.
ok(/attachPhotos\(/.test(updateBody),
  "and hands the strip to attachPhotos()");
const attachBody = admin.slice(admin.indexOf("export async function attachPhotos"),
                               admin.indexOf("export async function createProduct"));
ok(/image_url/.test(attachBody) && /images:/.test(attachBody),
  "and attachPhotos writes the resulting gallery onto the variants (behaviour proved in check_colour_photos.mjs Part D)");

// ---- the fields that always worked must keep working ----------------------
ok(captured?.name === "Heavyweight Tee", "the name is still carried");
ok(captured?.barcode === "5012345678900", "the product barcode is still carried");
ok(captured?.variants?.length === 2, "both colour/size cells are still carried");
ok(captured?.variants?.[0]?.barcode === "5012345678924", "and their barcodes");
ok(captured?.colourBarcodes?.[0]?.barcode === "5012345678917", "and the colour-tier barcode");

console.log("=".repeat(64));
console.log(" CHECK — THE EDIT FORM SAVES WHAT IT SHOWS");
console.log("=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) { console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length}`); process.exit(1); }
console.log(` ✓ PASS — ${pass.length} assertions.`);
