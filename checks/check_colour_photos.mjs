// =============================================================================
// CHECK: each colour carries its OWN photo                          (CR-0004)
// =============================================================================
// Hadi, 25 Aug 2026:
//   "When we set the colors, I don't see a mechanism to tie one of the images
//    to these colors... I want each color to have its own corresponding image.
//    And if it's not available, then it's not available from my client's side."
//
// This is a v1 REGRESSION, not a new idea. js/data/products-admin.js says so
// in its own comment: "v1 attached one photo per COLOUR, which is the better
// end state -- noted rather than half-built, since it needs the form to record
// which upload each colour sampled from and that mapping only exists
// client-side today." The form has recorded it all along (`colour.photoId`);
// readDraft() simply never sent it, and both save paths then wrote the SAME
// gallery to EVERY variant with .in(...) / .eq("product_id", ...).
//
// WHY THIS GATE IS SHAPED THE WAY IT IS
// -------------------------------------
// It does NOT read source text. A previous check in this repo asked only
// whether a name appeared in a file, which an unused `import` satisfies, and a
// feature stayed "present" through three rewrites that had dropped it. So this
// runs the REAL save paths against a recording fake of the Supabase client and
// asserts WHAT IS ACTUALLY WRITTEN to each variant row.
//
// Part A pins behaviour that must SURVIVE the change. Part B is the new
// requirement and is EXPECTED TO FAIL until the fix lands -- that is the point.
// Run it before the fix and you should see Part B red; that is the evidence
// the change was needed, and it is what stops this gate from being written to
// match the code instead of the requirement.
//
//   node checks/check_colour_photos.mjs
// =============================================================================

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// ---------------------------------------------------------------------------
// A recording fake of the Supabase client.
//
// Chainable and permissive on purpose: it must not force this gate to model
// every call products-admin.js makes, only to REMEMBER them. Anything it does
// not explicitly answer resolves to { data: null, error: null }, which the
// callers already treat as "nothing came back" rather than crashing.
// ---------------------------------------------------------------------------
const writes = [];        // every table write, in order

function makeClient() {
  let variantSeq = 0;
  return {
    from(table) {
      const rec = { table, op: null, payload: null, filters: {} };
      const chain = {
        insert(payload) {
          rec.op = "insert"; rec.payload = payload;
          writes.push(rec);
          return chain;
        },
        update(payload) { rec.op = "update"; rec.payload = payload; writes.push(rec); return chain; },
        delete() { rec.op = "delete"; writes.push(rec); return chain; },
        select() { return chain; },
        eq(col, val) { rec.filters[col] = val; return chain; },
        in(col, vals) { rec.filters[col] = vals; return chain; },
        order() { return chain; },
        single() { return chain; },
        maybeSingle() { return chain; },
        limit() { return chain; },
        not() { return chain; },
        is() { return chain; },
        // The await point. A variant insert has to hand back a real id, or the
        // caller has nothing to attach photos to and the whole path collapses
        // into a false green.
        then(res, rej) {
          let data = null;
          if (rec.table === "v2_products" && rec.op === "insert") {
            data = { id: "prod-1", name: rec.payload?.name || "P" };
          } else if (rec.table === "v2_product_variants" && !rec.op && globalThis.__liveVariants) {
            // updateProduct re-reads the live variants to learn their colours.
            data = globalThis.__liveVariants;
          } else if (rec.table === "v2_products" && !rec.op) {
            data = { id: "prod-1", wid: "wid-1", name: "Colour Photo Check" };
          } else if (rec.table === "v2_product_variants" && rec.op === "insert") {
            variantSeq += 1;
            data = { id: `var-${variantSeq}`, sku: rec.payload?.sku, extra_attrs: rec.payload?.extra_attrs };
            // The id is recorded ON the write record, so a check can ask what
            // was minted instead of re-deriving it from a counter it cannot see.
            rec.mintedId = data.id;
          }
          const out = { data, error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return chain;
    },
    rpc() { return Promise.resolve({ data: null, error: null }); },
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }),
                              getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

// The module graph reaches supabase-client.js, which reads window.supabase at
// import time. Nothing here touches the network.
globalThis.window = globalThis.window || {};
globalThis.window.supabase = { createClient: () => makeClient() };
globalThis.document = globalThis.document || { createElement: () => ({ getContext: () => null, toDataURL: () => "" }) };

// Photo upload is stubbed at the module boundary: this gate is about WHICH
// colour a url lands on, not about storage. The urls are distinctive so a
// mix-up is unmistakable in the failure message.
const URL_RED_1  = "https://cdn.test/red-1.webp";
const URL_RED_2  = "https://cdn.test/red-2.webp";
const URL_BLUE_1 = "https://cdn.test/blue-1.webp";

// ---------------------------------------------------------------------------
// A product with THREE colours and a deliberate asymmetry:
//   Red   -> two photos of its own
//   Blue  -> one photo of its own
//   Green -> NO photo at all        <- the case Hadi called out
// ---------------------------------------------------------------------------
function draftWithColourPhotos() {
  const file = (n) => ({ name: n, type: "image/webp", size: 10 });
  return {
    name: "Colour Photo Check",
    sellingModel: "open",
    // The three uploads, in strip order.
    photos: [file("red-1"), file("red-2"), file("blue-1")],
    // The mapping the form has always held and never sent.
    coloursPhotos: [
      { colour: "Red",   photoIndexes: [0, 1] },
      { colour: "Blue",  photoIndexes: [2] },
      { colour: "Green", photoIndexes: [] },
    ],
    variants: [
      { sku: "CPC-RED-S",   price: 10, color: "Red",   size: "S" },
      { sku: "CPC-RED-M",   price: 10, color: "Red",   size: "M" },
      { sku: "CPC-BLUE-S",  price: 10, color: "Blue",  size: "S" },
      { sku: "CPC-GREEN-S", price: 10, color: "Green", size: "S" },
    ],
  };
}

// Which urls ended up on which variant, according to the writes actually made.
function galleryByVariant() {
  const byVariant = new Map();
  writes.filter((w) => w.table === "v2_product_variants" && w.op === "update" && w.payload?.images !== undefined)
    .forEach((w) => {
      const ids = w.filters.id || (w.filters.product_id ? "ALL" : null);
      const targets = Array.isArray(ids) ? ids : ids === "ALL" ? "ALL" : [ids];
      byVariant.set(JSON.stringify(targets), w.payload.images || []);
    });
  return byVariant;
}

// ---------------------------------------------------------------------------
const mod = await import("../js/data/products-admin.js");

// The uploader is INJECTED, not monkey-patched.
//
// The first version of this gate tried Object.defineProperty on the uploads.js
// module namespace. ES module namespaces are frozen, so the patch silently did
// nothing, no photo ever "uploaded", and NOT ONE photo write was made -- at
// which point three assertions went GREEN because there was nothing to fail
// against. A gate whose setup can fail quietly is worse than no gate, so the
// uploader is now passed in, and PRECONDITIONS below refuse to let this file
// report success if the plumbing did not work.
// Keyed on the FILE'S NAME, not on how many times it has been called.
//
// The first version returned urls positionally by call count. That works on the
// create path, where all three photos upload in order -- and silently lies on
// the edit path, where two photos are already in storage and only ONE uploads,
// so the blue file came back as the red url and D5 failed for a reason that had
// nothing to do with the code under test. A stub that depends on call ORDER
// encodes an assumption the code is free to change.
let uploadCall = 0;
const BY_NAME = { "red-1": URL_RED_1, "red-2": URL_RED_2, "blue-1": URL_BLUE_1 };
const uploader = async ({ file }) => {
  uploadCall++;
  const url = BY_NAME[file?.name];
  // An unrecognised file is a broken fixture, not a passing test.
  if (!url) return { ok: false, error: `fixture has no url for "${file?.name}"` };
  return { ok: true, url };
};

writes.length = 0;
const res = await mod.createProduct("wid-1", draftWithColourPhotos(), { uploader });

// ── PRECONDITIONS — if the harness itself did not work, say so and STOP ────
// Everything below is meaningless unless the save path actually ran and the
// photos actually "uploaded". These are checked FIRST and exit hard, because
// a false green here is exactly how this gate lied on its first run.
const preFail = [];
if (!res) preFail.push("createProduct returned nothing at all");
if (uploadCall === 0) preFail.push("the injected uploader was never called — createProduct does not accept it yet");
if (!writes.some((w) => w.table === "v2_product_variants" && w.op === "insert"))
  preFail.push("no variants were inserted — the fake client is not answering correctly");
if (preFail.length) {
  console.log("\ncheck_colour_photos  HARNESS BROKEN — no verdict given");
  preFail.forEach((m) => console.log("  ! " + m));
  console.log("  (this is NOT a pass. Fix the harness or the injection point, then re-run.)");
  process.exit(2);
}

// ── PART A — what must SURVIVE ─────────────────────────────────────────────
ok(res && res.ok !== false, "A1 the product still saves (" + (res?.error || "ok") + ")");
const variantInserts = writes.filter((w) => w.table === "v2_product_variants" && w.op === "insert");
ok(variantInserts.length === 4, `A2 all four variants are still created (got ${variantInserts.length})`);
const photoWrites = writes.filter((w) => w.table === "v2_product_variants" && w.op === "update" && w.payload?.images !== undefined);
ok(photoWrites.length > 0, "A3 photos are still attached to variants at all");

// ── PART B — the new requirement. RED until the fix lands. ────────────────
// B1 is the whole change in one assertion: photos must be written per colour,
// which means MORE THAN ONE write, each aimed at a subset. Today there is
// exactly one write aimed at every variant.
ok(photoWrites.length >= 2,
   `B1 photos are written PER COLOUR, not once for the whole product ` +
   `(expected one write per photographed colour, got ${photoWrites.length})`);

const blanket = photoWrites.find((w) =>
  (Array.isArray(w.filters.id) && w.filters.id.length === variantInserts.length) || w.filters.product_id);
ok(!blanket,
   "B2 no write aims the same gallery at every variant" +
   (blanket ? ` (found one targeting ${blanket.filters.product_id ? "product_id" : "all " + blanket.filters.id.length + " variants"})` : ""));

// B3/B4 — the urls actually landed on the right colours.
const idOfSku = new Map(variantInserts.map((w, i) => [w.payload?.sku, `var-${i + 1}`]));
function galleryFor(sku) {
  const id = idOfSku.get(sku);
  const w = photoWrites.find((x) => {
    const f = x.filters.id;
    return Array.isArray(f) ? f.includes(id) : f === id;
  });
  return w ? (w.payload.images || []) : null;
}
const redG = galleryFor("CPC-RED-S"), blueG = galleryFor("CPC-BLUE-S"), greenG = galleryFor("CPC-GREEN-S");
ok(!!redG && redG.includes(URL_RED_1) && redG.includes(URL_RED_2) && !redG.includes(URL_BLUE_1),
   `B3 Red carries BOTH its own photos and none of Blue's (got ${JSON.stringify(redG)})`);
ok(!!blueG && blueG.includes(URL_BLUE_1) && !blueG.includes(URL_RED_1),
   `B4 Blue carries only its own photo (got ${JSON.stringify(blueG)})`);
ok(greenG === null || greenG.length === 0,
   `B5 a colour with NO photo is written NO photos — it never inherits (got ${JSON.stringify(greenG)})`);

// ── PART C — the buyer side must not borrow a sibling's photo ─────────────
// catalog.js currently falls back to product.primaryImage for a colour with no
// photography of its own. Harmless while every colour is identical; the moment
// colours differ it shows a buyer the wrong garment.
// FIRST VERSION READ THE WRONG FILE. It grepped js/data/catalog.js, where the
// borrow does not live -- so it passed while the fallback sat untouched in
// js/components/product-card.js:110. Reading a file that cannot contain the
// thing you are looking for is a green that means nothing. The path is now
// asserted to exist AND to contain the function, before its content is judged.
const fs = await import("node:fs");
const CARD = "js/components/product-card.js";
const cardSrc = fs.readFileSync(CARD, "utf8");
ok(/function photosFor\s*\(/.test(cardSrc),
   `C0 ${CARD} still contains photosFor() — the function this rule is about`);
ok(!/return\s+product\.primaryImage\s*\?/.test(cardSrc),
   `C1 ${CARD} no longer falls back to another colour's photo (the primaryImage borrow is gone)`);

// ── PART D — the EDIT path, which had the same disease ────────────────────
// updateProduct used .eq("product_id", id), an even broader blanket than
// create's. Editing one colour's photography rewrote every colour's.
//
// The fake answers the variant re-read with colours attached, because the edit
// path -- unlike create -- has to LOOK UP which variants exist. A product whose
// colours were renamed between saves is exactly why it cannot reuse an
// in-memory list.
const LIVE = [
  { id: "var-1", extra_attrs: { color: "Red" } },
  { id: "var-2", extra_attrs: { color: "Red" } },
  { id: "var-3", extra_attrs: { color: "Blue" } },
  { id: "var-4", extra_attrs: { color: "Green" } },
];
globalThis.__liveVariants = LIVE;

writes.length = 0;
uploadCall = 0;
const editRes = await mod.updateProduct("prod-1", {
  name: "Colour Photo Check",
  // updateProduct refuses a product with no variants, so the edit draft carries
  // the same four it is editing. Without them D1 fails for a reason that has
  // nothing to do with photography, and D2-D6 then pass on an empty list.
  variants: [
    { sku: "CPC-RED-S",   price: 10, color: "Red",   size: "S" },
    { sku: "CPC-RED-M",   price: 10, color: "Red",   size: "M" },
    { sku: "CPC-BLUE-S",  price: 10, color: "Blue",  size: "S" },
    { sku: "CPC-GREEN-S", price: 10, color: "Green", size: "S" },
  ],
  // The strip as it is on screen: two already in storage, one newly picked.
  photoStrip: [{ url: URL_RED_1 }, { url: URL_RED_2 }, { file: { name: "blue-1" } }],
  coloursPhotos: [
    { colour: "Red",   photoIndexes: [0, 1] },
    { colour: "Blue",  photoIndexes: [2] },
    { colour: "Green", photoIndexes: [] },
  ],
}, { uploader });

const editPhotoWrites = writes.filter((w) =>
  w.table === "v2_product_variants" && w.op === "update" && w.payload?.images !== undefined);
ok(editRes && editRes.ok !== false, `D1 editing still saves (${editRes?.error || "ok"})`);
// NOT vacuous. It first insists writes HAPPENED -- an empty list would
// otherwise satisfy "none of them targets product_id" and report green on a
// path that did nothing at all, which is how this gate lied on its first run.
ok(editPhotoWrites.length > 0 && !editPhotoWrites.some((w) => w.filters.product_id),
   `D2 the edit path no longer rewrites EVERY variant with .eq(product_id) ` +
   `(${editPhotoWrites.length} photo write(s) made)`);
ok(editPhotoWrites.length >= 2,
   `D3 the edit path writes photos per colour (got ${editPhotoWrites.length} writes)`);
const editGallery = (id) => {
  const w = editPhotoWrites.find((x) => (Array.isArray(x.filters.id) ? x.filters.id.includes(id) : x.filters.id === id));
  return w ? (w.payload.images || []) : null;
};
ok(JSON.stringify(editGallery("var-1")) === JSON.stringify([URL_RED_1, URL_RED_2]),
   `D4 on edit, Red keeps exactly its own two photos (got ${JSON.stringify(editGallery("var-1"))})`);
ok(JSON.stringify(editGallery("var-3")) === JSON.stringify([URL_BLUE_1]),
   `D5 on edit, Blue gets only the newly uploaded blue photo (got ${JSON.stringify(editGallery("var-3"))})`);
ok(JSON.stringify(editGallery("var-4")) === JSON.stringify([]),
   `D6 on edit, Green is written an EMPTY gallery — an unavailable colour stays unavailable (got ${JSON.stringify(editGallery("var-4"))})`);

// ── PART E — a caller that sends NO mapping must keep working ─────────────
// The CSV importer and the AI catalog import do not send coloursPhotos.
// Silently giving them zero photos would be a bigger regression than the one
// being fixed, so "absent" must still mean "put the gallery on everything".
writes.length = 0;
uploadCall = 0;
await mod.createProduct("wid-1", {
  name: "Legacy Caller",
  photos: [{ name: "red-1" }],
  variants: [
    { sku: "LC-RED-S",  price: 1, color: "Red",  size: "S" },
    { sku: "LC-BLUE-S", price: 1, color: "Blue", size: "S" },
  ],
}, { uploader });
const legacy = writes.filter((w) => w.table === "v2_product_variants" && w.op === "update" && w.payload?.images !== undefined);
ok(legacy.length === 1 && Array.isArray(legacy[0].filters.id) && legacy[0].filters.id.length === 2,
   `E1 a caller sending no mapping still gets the old behaviour — one gallery on every variant (got ${legacy.length} write(s))`);

// ── PART F — a FAILED upload must not slide the others onto wrong colours ──
// This part exists because a red-proof failed to go red. Collapsing the
// uploaded urls with .push() instead of holding position looked identical in
// every other fixture here -- because every other fixture uploads successfully.
// The bug only appears when ONE upload fails mid-strip, and then it does not
// drop a photo: it hands the NEXT colour's photograph to the previous one.
// Silent, plausible, and wrong. No gate is finished until it has actually been
// seen to fail on the thing it claims to protect.
writes.length = 0;
uploadCall = 0;
await mod.createProduct("wid-1", {
  name: "Upload Failure",
  //                    index 0        index 1 (WILL FAIL)   index 2
  photos: [{ name: "red-1" }, { name: "not-in-fixture" }, { name: "blue-1" }],
  coloursPhotos: [
    { colour: "Red",  photoIndexes: [0, 1] },   // asks for the failed one too
    { colour: "Blue", photoIndexes: [2] },
  ],
  variants: [
    { sku: "UF-RED-S",  price: 1, color: "Red",  size: "S" },
    { sku: "UF-BLUE-S", price: 1, color: "Blue", size: "S" },
  ],
}, { uploader });

const fWrites = writes.filter((w) => w.table === "v2_product_variants" && w.op === "update" && w.payload?.images !== undefined);
// Ids are looked up by SKU rather than hard-coded. The fake's variant counter
// runs across every product this file creates, so "var-1" means something
// different by Part F than it did in Part B -- and a wrong id returns null,
// which fails for a reason that has nothing to do with the rule being tested.
const fInserts = writes.filter((w) => w.table === "v2_product_variants" && w.op === "insert");
const fInsertIds = fInserts.map((w) => w.mintedId);
const fGallery = (sku) => {
  // Match on the write that targets the same position as this sku's insert.
  const idx = fInserts.findIndex((w) => w.payload?.sku === sku);
  if (idx < 0) return null;
  const id = fInsertIds[idx];
  const w = fWrites.find((x) => (Array.isArray(x.filters.id) ? x.filters.id.includes(id) : x.filters.id === id));
  return w ? (w.payload.images || []) : null;
};
ok(fWrites.length >= 2, `F0 photos were still written per colour after a failed upload (got ${fWrites.length})`);
ok(JSON.stringify(fGallery("UF-RED-S")) === JSON.stringify([URL_RED_1]),
   `F1 the failed photo leaves a HOLE — Red keeps only its own surviving photo and does NOT absorb Blue's (got ${JSON.stringify(fGallery("UF-RED-S"))})`);
ok(JSON.stringify(fGallery("UF-BLUE-S")) === JSON.stringify([URL_BLUE_1]),
   `F2 Blue still gets its own photo after an earlier upload failed (got ${JSON.stringify(fGallery("UF-BLUE-S"))})`);

console.log(`\ncheck_colour_photos  PASS ${pass.length}  FAIL ${fail.length}`);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
if (fail.length) process.exit(1);
