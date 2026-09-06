// =============================================================================
// OGGI Wholesale v2 — RECEIVE A WHOLE PRODUCT              (CNT-00, 6 Sep 2026)
// =============================================================================
//
// THE REPORTED PROBLEM
// A wholesaler buys 250 pieces, enters the colours and sizes, misclicks, and
// the breakdown totals 270. Nothing stops the save. The invoice says one
// number and the stock says another.
//
// WHAT WAS FOUND IN THE CODE, NOT ASSUMED
// js/components/receive-dialog.js takes ONE variant and ONE number. Receiving
// 250 pieces of a style in 4 colours and 4 sizes means opening it SIXTEEN
// times and typing sixteen numbers -- and nothing in the system adds them up,
// and nothing compares the total to the vendor's invoice. There is no screen
// on which the wholesaler can see what he has entered against what he was
// billed. The error is not merely possible; there is no mechanism by which it
// could be caught.
//
// DERIVE, DO NOT RECONCILE
// The reference ERP lets two numbers exist and offers a Sync button to argue
// between them: "Invoice Qty 2.999" beside "Selected Qty 3", and nothing
// blocks Done. That is the wrong shape. ANY TWO NUMBERS A PERSON CAN TYPE
// SEPARATELY WILL EVENTUALLY DISAGREE.
//
// So the quantity is never typed twice. The wholesaler types what the vendor
// billed, once, at the top. The grid is where actual pieces are placed. The
// total is the sum of the grid, always, and it is not an input. Save is
// refused while the two disagree -- refused, not warned (CNT-03) -- and the
// button says which way and by how much (CNT-04).
//
// THE GATE IS NECESSARY AND NOT SUFFICIENT.
// Nobody types 32 numbers correctly. The gate catches the error; the fill
// tools are what prevent it, and the saved curve is what prevents it the
// SECOND time, because nobody types sixteen numbers correctly twice.
//
// THIS COMPONENT OWNS NO DATABASE WRITE. It is handed its product and its
// saved curves and hands back a plan; the caller writes. Same discipline as
// receive-dialog.js, and the reason a Node gate can drive the whole screen.
// =============================================================================

import { esc } from "../lib/utils.js";
import { coloursOf, sizesInOrder, variantAt, colourMeta } from "../lib/variant-grid.js";

/** Whole pieces only. CNT-05: no decimals and no spinner arrows -- the 2.999
 *  in the reference ERP is that system's spinner, not a number anyone typed.
 *  Typing beats stepping on a count of physical objects. */
function whole(v) {
  const n = parseInt(String(v == null ? "" : v).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Largest-remainder apportionment. Used by both fill tools so they cannot
 *  disagree about where a remainder lands: the cells with the biggest
 *  fractional part get the spare pieces, which is the only split that is
 *  stable and explainable ("the extra 2 went to L and XL").
 *
 *  @param {number} total     pieces to place
 *  @param {number[]} weights one weight per cell; zero weights get nothing
 *  @returns {number[]} integers summing EXACTLY to total
 */
export function apportion(total, weights) {
  const w = (weights || []).map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (!sum || !total) return w.map(() => 0);
  const exact = w.map((x) => (total * x) / sum);
  const base = exact.map((x) => Math.floor(x));
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x), w: w[i] }))
    .filter((o) => o.w > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && order.length; k++, left--) base[order[k % order.length].i] += 1;
  return base;
}

/** The key a cell is stored under.
 *
 *  U+0000, not a space. A space looks tidier and is wrong: a wholesaler with a
 *  colour called "Navy Blue" and a size called "S" would collide with a colour
 *  called "Navy" and a size called "Blue S", and the two would silently share
 *  one box. NUL cannot appear in a colour or size name that came from a form,
 *  so it is the one separator that cannot be typed into a collision.
 *
 *  Written as an escape and never as a literal byte: a raw NUL in a source
 *  file makes it "binary" to grep, to git and to every editor, which is how a
 *  character nobody can see ends up load-bearing. Exported so the gate builds
 *  its keys the same way this file does rather than assuming the separator.
 */
export const CELL_SEP = "\u0000";
export const cellKey = (colour, size) => colour + CELL_SEP + size;

/** Parse a packing list pasted out of Excel. CNT-14: vendors send Excel, and
 *  typing it again is the largest single source of error we have.
 *
 *  Forgiving on purpose. It accepts a header row of sizes or no header, tabs
 *  or commas, and it MATCHES BY NAME wherever it can -- a paste that silently
 *  lands in the wrong columns is worse than a paste that refuses.
 *
 *  Returns { cells: Map keyed by cellKey(colour,size) -> qty, matched, skipped[] } and
 *  never throws: the caller shows what landed and what did not.
 */
export function parsePackingList(text, colours, sizes) {
  const out = { cells: new Map(), matched: 0, skipped: [] };
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((r) => r.split(/\t|,|;|\s\s+/).map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));
  if (!rows.length) return out;

  const norm = (s) => String(s || "").trim().toLowerCase();
  const colourBy = new Map((colours || []).map((c) => [norm(c), c]));
  const sizeBy = new Map((sizes || []).map((s) => [norm(s), s]));

  // A header row is one whose cells (after the first) name sizes we know.
  let header = null;
  let start = 0;
  const first = rows[0];
  const known = first.slice(1).filter((c) => sizeBy.has(norm(c))).length;
  if (known >= Math.max(1, Math.floor((first.length - 1) / 2))) {
    header = first.slice(1).map((c) => sizeBy.get(norm(c)) || null);
    start = 1;
  }

  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const colour = colourBy.get(norm(row[0]));
    if (!colour) { out.skipped.push(row[0] || ("row " + (r + 1))); continue; }
    const cells = row.slice(1);
    for (let i = 0; i < cells.length; i++) {
      // By NAME when the paste carried a header, by POSITION only when it did
      // not -- and position falls back to the grid's own size order, which is
      // the order on screen the person is looking at.
      const size = header ? header[i] : sizes[i];
      if (!size) continue;
      const qty = whole(cells[i]);
      if (qty > 0) { out.cells.set(cellKey(colour, size), qty); out.matched += 1; }
    }
  }
  return out;
}

/**
 * @param {object}   o
 * @param {object}   o.product        { id, name, variants:[{ id|variantId, extra_attrs|color|size, sku, onHand }] }
 * @param {string}   o.locationName   name of the warehouse, when there is one
 * @param {Array}    [o.locations]    [{id,name}] when there is more than one --
 *                                    the picker lives INSIDE this component so
 *                                    that changing warehouse does not throw
 *                                    away sixteen boxes of typing
 * @param {number}   [o.packSize]     pieces per carton, when the product is
 *                                    bought in cartons. Changes the UNIT of
 *                                    every box on the grid -- see below.
 * @param {Array}    [o.savedRatios]  [{ id, name, sizes:[], weights:[] }]
 * @param {Function} [o.onSaveRatio]  async ({name, sizes, weights}) => {ok,error?}
 * @param {Function} o.onConfirm      async ({ billed, total, pieces, unitsPerBox, lines, locationId })
 *                                    => { ok, error? }
 * @param {Function} [o.onCancel]
 * @returns {HTMLElement}
 */
export function renderReceiveProduct({
  product, locationName, locations = [], packSize = 1, savedRatios = [],
  onSaveRatio = null, onConfirm, onCancel = () => {},
}) {
  const el = document.createElement("div");
  el.className = "rcvp";

  const colours = coloursOf(product);
  const sizes = sizesInOrder(product);

  if (!colours.length || !sizes.length) {
    // Says what is missing rather than rendering an empty grid that looks
    // broken -- the same lesson order-setup.js records.
    el.innerHTML =
      '<div class="rcvp-title">Receive ' + esc((product && product.name) || "product") + "</div>" +
      '<div class="rcvp-sub">This product has ' + (colours.length ? "no sizes" : "no colours or sizes") +
      " yet, so there is no grid to count into. Add them on the product first.</div>";
    return el;
  }

  // Pieces per box on the grid. 1 = the grid takes pieces; >1 = it takes
  // CARTONS and pieces are computed. Somebody entering 250 into a field that
  // means cartons is exactly how a 250 becomes a 6,000, so the unit is
  // written on the field rather than assumed.
  const per = Number.isFinite(packSize) && packSize > 1 ? Math.floor(packSize) : 1;
  const unit = per > 1 ? "cartons" : "pieces";


  /** qty per cell. Cells with no variant are absent, not zero: "we do not
   *  make it" and "we received none" are different statements. */
  const q = new Map();
  const cellExists = (c, s) => !!variantAt(product, c, s);
  const get = (c, s) => q.get(cellKey(c, s)) || 0;
  const put = (c, s, n) => { if (cellExists(c, s)) q.set(cellKey(c, s), Math.max(0, n | 0)); };

  /** CNT-08: one-level undo on every bulk action. A misclick costs a tap, not
   *  a re-count. Deliberately ONE level -- an undo stack invites exploring,
   *  and this screen is somebody standing in a stockroom. */
  let undoSnapshot = null;
  let undoLabel = "";
  const snapshot = (label) => { undoSnapshot = new Map(q); undoLabel = label; };

  const boxCount = () => colours.reduce((n, c) => n + sizes.filter((s) => cellExists(c, s)).length, 0);
  const entered = () => {
    let t = 0;
    q.forEach((v) => { t += v; });
    return t;
  };
  const piecesTotal = () => entered() * per;

  el.innerHTML =
    '<div class="rcvp-head">' +
      "<div>" +
        '<div class="rcvp-title">Receive ' + esc(product.name) + "</div>" +
        '<div class="rcvp-sub">' +
          (locations.length > 1
            ? 'into <select class="input rcvp-loc" id="rcvp-loc">' +
                locations.map((l) => '<option value="' + esc(l.id) + '">' + esc(l.name) + "</option>").join("") +
              "</select>"
            : "into " + esc(locationName || "your warehouse")) +
          " &middot; " + boxCount() + " boxes &middot; counting in <strong>" + unit + "</strong>" +
          (per > 1 ? " of " + per : "") + "</div>" +
      "</div>" +
      '<label class="rcvp-billed">' +
        "<span>How many did the invoice say?</span>" +
        '<input class="input" id="rcvp-billed" type="text" inputmode="numeric" autocomplete="off" placeholder="0">' +
        '<span class="rcvp-billed-unit">' + unit + "</span>" +
      "</label>" +
    "</div>" +

    '<div class="rcvp-tools" role="group" aria-label="Fill tools">' +
      '<button class="btn btn-secondary btn-sm" data-t="spread" type="button">Spread evenly</button>' +
      '<button class="btn btn-secondary btn-sm" data-t="curve" type="button">Size curve</button>' +
      '<button class="btn btn-secondary btn-sm" data-t="paste" type="button">Paste from a packing list</button>' +
      '<button class="btn btn-ghost btn-sm" data-t="clear" type="button">Clear</button>' +
      '<button class="btn btn-ghost btn-sm" data-t="undo" type="button" hidden>Undo</button>' +
    "</div>" +
    '<div class="rcvp-note" id="rcvp-note" role="status"></div>' +
    '<div class="rcvp-panel" id="rcvp-panel" hidden></div>' +

    '<div class="rcvp-grid" id="rcvp-grid"></div>' +

    '<div class="rcvp-foot">' +
      '<div class="rcvp-tally" id="rcvp-tally" role="status"></div>' +
      '<div class="rcvp-actions">' +
        '<button class="btn btn-ghost" data-a="cancel" type="button">Cancel</button>' +
        '<button class="btn btn-primary" data-a="confirm" type="button" disabled>Enter the invoice quantity</button>' +
      "</div>" +
    "</div>";

  const billedEl = el.querySelector("#rcvp-billed");
  const gridEl = el.querySelector("#rcvp-grid");
  const tallyEl = el.querySelector("#rcvp-tally");
  const noteEl = el.querySelector("#rcvp-note");
  const panelEl = el.querySelector("#rcvp-panel");
  const confirmEl = el.querySelector('[data-a="confirm"]');
  const undoEl = el.querySelector('[data-t="undo"]');

  const billed = () => whole(billedEl.value);
  const say = (msg) => { noteEl.textContent = msg || ""; };

  // ---------------------------------------------------------------- grid ---
  // CNT-07: ONE CARD PER COLOUR, sizes wrap. No horizontal scrolling, on any
  // screen. A grid that scrolls sideways hides the very columns whose totals
  // the person is checking, and on a phone it hides most of them.
  const inputs = new Map();
  const rowTotalEls = new Map();
  const colTotalEls = new Map();

  function buildGrid() {
    gridEl.innerHTML = "";
    colours.forEach((c) => {
      const meta = colourMeta(product, c);
      const card = document.createElement("div");
      card.className = "rcvp-colour";

      const head = document.createElement("div");
      head.className = "rcvp-colour-head";
      const sw = document.createElement("span");
      sw.className = "rcvp-swatch";
      sw.style.background = meta.hex;
      const nm = document.createElement("span");
      nm.className = "rcvp-colour-name";
      nm.textContent = c;
      const rt = document.createElement("span");
      rt.className = "rcvp-rowtotal";
      rt.textContent = "0";
      rowTotalEls.set(c, rt);
      head.appendChild(sw);
      head.appendChild(nm);
      head.appendChild(rt);

      // CNT-13: one number down a whole colour. Sits on the colour's own row
      // because that is the thing it acts on -- a tool parked in a toolbar
      // has to name its target, and a name is one more thing to get wrong.
      const fill = document.createElement("button");
      fill.type = "button";
      fill.className = "btn btn-ghost btn-sm rcvp-fillrow";
      fill.textContent = "Fill";
      fill.title = "Put the same number in every size of " + c;
      fill.dataset.fillColour = c;
      head.appendChild(fill);

      const cells = document.createElement("div");
      cells.className = "rcvp-cells";

      sizes.forEach((s) => {
        const cell = document.createElement("label");
        cell.className = "rcvp-cell";
        const lab = document.createElement("span");
        lab.className = "rcvp-size";
        lab.textContent = s;
        cell.appendChild(lab);

        if (!cellExists(c, s)) {
          // Rendered, not omitted: an absent box in the middle of a run is
          // information ("you do not make Navy in XS"), and hiding it makes
          // the columns stop lining up between colours.
          cell.classList.add("is-absent");
          const na = document.createElement("span");
          na.className = "rcvp-na";
          na.textContent = "—";
          na.title = "You do not make " + c + " in " + s;
          cell.appendChild(na);
        } else {
          const inp = document.createElement("input");
          inp.className = "input rcvp-q";
          inp.type = "text";            // CNT-05: no spinner on a piece count
          inp.inputMode = "numeric";
          inp.autocomplete = "off";
          inp.placeholder = "0";
          inp.dataset.colour = c;
          inp.dataset.size = s;
          inp.setAttribute("aria-label", c + " " + s);
          inp.addEventListener("input", () => { put(c, s, whole(inp.value)); paint(); });
          cell.appendChild(inp);
          inputs.set(cellKey(c, s), inp);
        }
        cells.appendChild(cell);
      });

      card.appendChild(head);
      card.appendChild(cells);
      gridEl.appendChild(card);
    });

    // CNT-06: a column total per size, always on screen. A mistake shows up
    // where it happened -- "there are 40 in the M column and you bought 20" --
    // rather than only in a global counter that says the total is wrong and
    // leaves you to find out where.
    const foot = document.createElement("div");
    foot.className = "rcvp-coltotals";
    const flab = document.createElement("div");
    flab.className = "rcvp-coltotals-label";
    flab.textContent = "Per size";
    const fcells = document.createElement("div");
    fcells.className = "rcvp-coltotals-cells";
    sizes.forEach((s) => {
      const wrap = document.createElement("span");
      wrap.className = "rcvp-coltotal";
      const lab = document.createElement("span");
      lab.className = "rcvp-size";
      lab.textContent = s;
      const b = document.createElement("b");
      b.textContent = "0";
      colTotalEls.set(s, b);
      wrap.appendChild(lab);
      wrap.appendChild(b);

      const fill = document.createElement("button");
      fill.type = "button";
      fill.className = "btn btn-ghost btn-sm rcvp-fillcol";
      fill.textContent = "Fill";
      fill.title = "Put the same number in every colour of " + s;
      fill.dataset.fillSize = s;
      wrap.appendChild(fill);

      fcells.appendChild(wrap);
    });
    foot.appendChild(flab);
    foot.appendChild(fcells);
    gridEl.appendChild(foot);

    gridEl.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.fillColour) askFill("colour", t.dataset.fillColour);
      if (t.dataset.fillSize) askFill("size", t.dataset.fillSize);
    });
  }

  function syncInputs() {
    inputs.forEach((inp, k) => {
      const v = q.get(k) || 0;
      const shown = v > 0 ? String(v) : "";
      if (inp.value !== shown) inp.value = shown;
    });
  }

  // --------------------------------------------------------------- tally ---
  function paint() {
    colours.forEach((c) => {
      let t = 0;
      sizes.forEach((s) => { t += get(c, s); });
      const node = rowTotalEls.get(c);
      if (node) node.textContent = String(t);
    });
    sizes.forEach((s) => {
      let t = 0;
      colours.forEach((c) => { t += get(c, s); });
      const node = colTotalEls.get(s);
      if (node) node.textContent = String(t);
    });

    const b = billed();
    const e = entered();
    const diff = e - b;

    tallyEl.innerHTML = b === 0
      ? '<span class="rcvp-t-lab">Entered</span> <b>' + e + "</b> " + unit +
        (per > 1 ? " &middot; " + piecesTotal() + " pieces" : "")
      : '<span class="rcvp-t-lab">Billed</span> <b>' + b + "</b>" +
        '<span class="rcvp-t-sep">&middot;</span>' +
        '<span class="rcvp-t-lab">Entered</span> <b>' + e + "</b>" +
        '<span class="rcvp-t-sep">&middot;</span>' +
        '<span class="rcvp-t-lab">Difference</span> ' +
        '<b class="' + (diff === 0 ? "is-ok" : "is-off") + '">' +
          (diff === 0 ? "0" : (diff > 0 ? "+" + diff : String(diff))) + "</b>" +
        (per > 1 ? '<span class="rcvp-t-sep">&middot;</span><span class="rcvp-t-lab">' + piecesTotal() + " pieces</span>" : "");

    // CNT-04: THE BUTTON CARRIES THE REASON. Never a generic Save that fails
    // after you press it -- the person is standing at a bench with a box in
    // their hands, and "20 too many" is the whole answer without a dialog.
    if (b === 0) {
      confirmEl.disabled = true;
      confirmEl.textContent = "Enter the invoice quantity";
    } else if (diff > 0) {
      confirmEl.disabled = true;
      confirmEl.textContent = diff + " too many";
    } else if (diff < 0) {
      confirmEl.disabled = true;
      confirmEl.textContent = (-diff) + " still to enter";
    } else {
      confirmEl.disabled = false;
      confirmEl.textContent = per > 1
        ? "Receive " + e + " cartons (" + piecesTotal() + " pieces)"
        : "Receive " + e + " pieces";
    }

    undoEl.hidden = !undoSnapshot;
    if (undoSnapshot) undoEl.textContent = "Undo " + undoLabel;
  }

  // --------------------------------------------------------------- tools ---
  function needBilled() {
    if (billed() > 0) return true;
    say("Type what the invoice said first — the fill tools have nothing to spread until then.");
    billedEl.focus();
    return false;
  }

  /** CNT-11. Divides the billed quantity across every box that exists, and
   *  NAMES WHERE THE REMAINDER WENT (CNT-09). A remainder is never silently
   *  dropped: 250 across 16 boxes is 15 each with 10 left over, and the person
   *  needs to know the 10 are not floating somewhere. */
  function spreadEvenly() {
    if (!needBilled()) return;
    snapshot("spread evenly");
    const cells = [];
    colours.forEach((c) => sizes.forEach((s) => { if (cellExists(c, s)) cells.push([c, s]); }));
    const parts = apportion(billed(), cells.map(() => 1));
    q.clear();
    cells.forEach((cs, i) => put(cs[0], cs[1], parts[i]));
    const each = Math.floor(billed() / cells.length);
    const spare = billed() - each * cells.length;
    syncInputs();
    paint();
    say(spare === 0
      ? billed() + " " + unit + " across " + cells.length + " boxes — " + each + " in each, nothing left over."
      : billed() + " does not divide by " + cells.length + " — " + each + " in each box, and the extra " +
        spare + " went to " + cells.slice(0, spare).map((cs) => cs[0] + " " + cs[1]).join(", ") + ".");
  }

  /** CNT-12. A curve is how many of each size make one set, written the way
   *  the trade writes it: 2-3-3-2. Clothing never arrives flat.
   *
   *  NOTE ON applyRatio(): the spec described this as "applyRatio() wired up
   *  at last". The code disagrees -- applyRatio() calls v2_apply_ratio and
   *  builds PACKS on a product; it does not spread a quantity across a grid.
   *  What this needs is the curve's WEIGHTS, which listRatios() already
   *  returns. createRatio() is the function with no caller since 24 August,
   *  and the "Save this curve" button below is its first one. */
  function applyCurve(weights, curveSizes, label) {
    if (!needBilled()) return;
    snapshot("the " + label + " curve");
    // Match by size NAME, not by position: a curve saved for S-M-L-XL applied
    // to a product that also has XXL must not shift one column left and fill
    // the wrong boxes, which is the failure nobody would spot afterwards.
    const wBySize = new Map();
    (curveSizes || []).forEach((s, i) => wBySize.set(String(s), Number(weights[i]) || 0));
    const cells = [];
    const cellW = [];
    colours.forEach((c) => sizes.forEach((s) => {
      if (!cellExists(c, s)) return;
      cells.push([c, s]);
      cellW.push(wBySize.has(String(s)) ? wBySize.get(String(s)) : 0);
    }));
    const unmatched = sizes.filter((s) => !wBySize.has(String(s)));
    if (!cellW.some((w) => w > 0)) {
      undoSnapshot = null;
      paint();
      say("That curve covers " + (curveSizes || []).join(", ") +
          ", and this product has none of those sizes. Nothing was changed.");
      return;
    }
    const parts = apportion(billed(), cellW);
    q.clear();
    cells.forEach((cs, i) => put(cs[0], cs[1], parts[i]));
    syncInputs();
    paint();
    say(label + " applied — " + billed() + " " + unit + " shared by the curve." +
        (unmatched.length
          ? " " + unmatched.join(", ") + (unmatched.length === 1 ? " is" : " are") + " not in this curve and got none."
          : ""));
  }

  /** CNT-13. One number down a colour, or across a size. */
  function askFill(kind, name) {
    panelEl.hidden = false;
    panelEl.innerHTML =
      '<div class="rcvp-panel-title">Fill ' + esc(name) + "</div>" +
      '<div class="rcvp-panel-sub">The same number in every ' +
        (kind === "colour" ? "size of this colour" : "colour of this size") + ".</div>" +
      '<div class="rcvp-panel-actions">' +
        '<input class="input rcvp-fillqty" id="rcvp-fillqty" type="text" inputmode="numeric" placeholder="0" autocomplete="off">' +
        '<button class="btn btn-primary btn-sm" data-c="do" type="button">Fill</button>' +
        '<button class="btn btn-ghost btn-sm" data-c="close" type="button">Close</button>' +
      "</div>";
    const qtyEl = panelEl.querySelector("#rcvp-fillqty");
    panelEl.querySelector('[data-c="close"]').addEventListener("click", closePanel);
    panelEl.querySelector('[data-c="do"]').addEventListener("click", () => {
      const n = whole(qtyEl.value);
      snapshot(kind === "colour" ? "fill " + name : "fill size " + name);
      if (kind === "colour") sizes.forEach((s) => put(name, s, n));
      else colours.forEach((c) => put(c, name, n));
      syncInputs();
      paint();
      closePanel();
      say(n + " in every " + (kind === "colour" ? "size of " + name : "colour of " + name) + ".");
    });
    qtyEl.focus();
  }

  function closePanel() { panelEl.hidden = true; panelEl.innerHTML = ""; }

  /** The curve panel: pick a saved curve, or write one and save it.
   *  CNT-15 lives here -- "Name it and save it" is the whole return on this
   *  feature, because nobody types sixteen numbers correctly twice. */
  function openCurvePanel() {
    panelEl.hidden = false;
    panelEl.innerHTML =
      '<div class="rcvp-panel-title">Size curve</div>' +
      '<div class="rcvp-panel-sub">How many of each size make one set. Written the way the trade writes it: 2-3-3-2.</div>' +
      '<div class="rcvp-saved" id="rcvp-saved"></div>' +
      '<div class="rcvp-curve" id="rcvp-curve"></div>' +
      '<div class="rcvp-panel-actions">' +
        '<input class="input rcvp-curve-name" id="rcvp-curve-name" type="text" placeholder="Name this curve" autocomplete="off">' +
        '<button class="btn btn-secondary btn-sm" data-c="save" type="button"' + (onSaveRatio ? "" : " hidden") + ">Save this curve</button>" +
        '<button class="btn btn-primary btn-sm" data-c="fill" type="button">Fill the boxes</button>' +
        '<button class="btn btn-ghost btn-sm" data-c="close" type="button">Close</button>' +
      "</div>" +
      '<div class="rcvp-panel-note" id="rcvp-curve-note" role="status"></div>';

    const savedHost = panelEl.querySelector("#rcvp-saved");
    if (savedRatios.length) {
      savedRatios.forEach((r) => {
        // TWO buttons per saved curve, and the difference matters.
        //
        // "Fill now" is the whole return on this feature -- the spec's "next
        // delivery of that style is one tap" -- and it is also the ONLY caller
        // that hands applyCurve a size list different from the screen's. That
        // is why the match is by size NAME: a curve saved for M-L applied to a
        // product that also has S and XL must leave those at zero and say so,
        // not shift the run two columns across. Loading into the boxes first
        // (the second button) is for when the curve needs a tweak before it
        // goes in.
        const now = document.createElement("button");
        now.type = "button";
        now.className = "btn btn-secondary btn-sm";
        now.textContent = "Fill now: " + r.name + " (" + (r.weights || []).join("-") + ")";
        now.dataset.fillNow = r.name;
        now.addEventListener("click", () => {
          applyCurve(r.weights || [], r.sizes || [], r.name);
          closePanel();
        });
        savedHost.appendChild(now);

        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-ghost btn-sm";
        b.dataset.loadCurve = r.name;
        b.textContent = "Edit " + r.name;
        b.addEventListener("click", () => {
          // Load by NAME onto the sizes this product actually has. A saved
          // curve for S-M-L applied to S-M-L-XL leaves XL at zero and says so,
          // rather than silently shifting the run one column across.
          sizes.forEach((s) => {
            const box = panelEl.querySelector('[data-w="' + cssEscape(String(s)) + '"]');
            if (box) box.value = "0";
          });
          (r.sizes || []).forEach((s, i) => {
            const box = panelEl.querySelector('[data-w="' + cssEscape(String(s)) + '"]');
            if (box) box.value = String((r.weights || [])[i] == null ? 0 : r.weights[i]);
          });
          const nameEl = panelEl.querySelector("#rcvp-curve-name");
          if (nameEl && !nameEl.value) nameEl.value = r.name;
          paintCurveNote();
        });
        savedHost.appendChild(b);
      });
    } else {
      savedHost.innerHTML =
        '<span class="rcvp-panel-sub">No saved curves yet. Write one below and save it — next delivery of this style is one tap.</span>';
    }

    const curveHost = panelEl.querySelector("#rcvp-curve");
    sizes.forEach((s) => {
      const w = document.createElement("label");
      w.className = "rcvp-w";
      const lab = document.createElement("span");
      lab.className = "rcvp-size";
      lab.textContent = s;
      const inp = document.createElement("input");
      inp.className = "input";
      inp.type = "text";
      inp.inputMode = "numeric";
      inp.dataset.w = s;
      inp.value = "0";
      inp.addEventListener("input", paintCurveNote);
      w.appendChild(lab);
      w.appendChild(inp);
      curveHost.appendChild(w);
    });

    const readCurve = () => sizes.map((s) => {
      const box = panelEl.querySelector('[data-w="' + cssEscape(String(s)) + '"]');
      return box ? whole(box.value) : 0;
    });

    /** The live arithmetic the spec asks for: one set, one full run across the
     *  colours, how many runs fit the invoice, and what is left over. This is
     *  the part with no screen today. */
    function paintCurveNote() {
      const w = readCurve();
      const oneSet = w.reduce((a, b) => a + b, 0);
      const note = panelEl.querySelector("#rcvp-curve-note");
      if (!note) return;
      if (!oneSet) { note.textContent = "Put a number under at least one size."; return; }
      const run = oneSet * colours.length;
      const b = billed();
      note.textContent = b
        ? "One set is " + oneSet + " " + unit + ". One full run across " + colours.length +
          " colour" + (colours.length === 1 ? "" : "s") + " is " + run + ". " +
          Math.floor(b / run) + " run" + (Math.floor(b / run) === 1 ? "" : "s") +
          " fit the invoice of " + b + ", with " + (b % run) +
          " left over — the fill places the remainder rather than dropping it."
        : "One set is " + oneSet + " " + unit + "; one full run across " + colours.length +
          " colour" + (colours.length === 1 ? "" : "s") + " is " + run + ".";
    }
    paintCurveNote();

    panelEl.querySelector('[data-c="close"]').addEventListener("click", closePanel);
    panelEl.querySelector('[data-c="fill"]').addEventListener("click", () => {
      const nm = panelEl.querySelector("#rcvp-curve-name").value.trim();
      applyCurve(readCurve(), sizes, nm || "That curve");
      closePanel();
    });

    const saveBtn = panelEl.querySelector('[data-c="save"]');
    if (saveBtn && onSaveRatio) {
      saveBtn.addEventListener("click", async () => {
        const name = panelEl.querySelector("#rcvp-curve-name").value.trim();
        const weights = readCurve();
        const note = panelEl.querySelector("#rcvp-curve-note");
        if (!name) { note.textContent = "Give the curve a name so you can find it next time."; return; }
        if (!weights.some((x) => x > 0)) { note.textContent = "Put a number under at least one size before saving."; return; }
        saveBtn.disabled = true;
        const res = await onSaveRatio({ name, sizes, weights });
        saveBtn.disabled = false;
        if (res && res.ok === false) { note.textContent = res.error || "That curve could not be saved."; return; }
        savedRatios = savedRatios.concat([{ name, sizes, weights }]);
        note.textContent = "Saved as “" + name + "”. Next delivery of this style is one tap.";
      });
    }
  }

  /** CNT-14. Vendors send Excel. */
  function openPastePanel() {
    panelEl.hidden = false;
    panelEl.innerHTML =
      '<div class="rcvp-panel-title">Paste from a packing list</div>' +
      '<div class="rcvp-panel-sub">Copy the block out of the vendor’s sheet and paste it here. First column the colour, one column per size. A header row of sizes is used if it is there.</div>' +
      '<textarea class="input rcvp-paste" id="rcvp-paste" rows="6"></textarea>' +
      '<div class="rcvp-panel-actions">' +
        '<button class="btn btn-primary btn-sm" data-c="apply" type="button">Fill the boxes</button>' +
        '<button class="btn btn-ghost btn-sm" data-c="close" type="button">Close</button>' +
      "</div>" +
      '<div class="rcvp-panel-note" id="rcvp-paste-note" role="status"></div>';
    panelEl.querySelector('[data-c="close"]').addEventListener("click", closePanel);
    panelEl.querySelector('[data-c="apply"]').addEventListener("click", () => {
      const res = parsePackingList(panelEl.querySelector("#rcvp-paste").value, colours, sizes);
      const note = panelEl.querySelector("#rcvp-paste-note");
      if (!res.matched) {
        note.textContent = res.skipped.length
          ? "Nothing matched. These did not look like colours of this product: " + res.skipped.slice(0, 6).join(", ") + "."
          : "Nothing matched — check that the first column holds the colour names.";
        return;
      }
      snapshot("the pasted list");
      q.clear();
      res.cells.forEach((v, k) => {
        const parts = k.split(CELL_SEP);
        put(parts[0], parts[1], v);
      });
      syncInputs();
      paint();
      closePanel();
      say(res.matched + " boxes filled from the paste." +
          (res.skipped.length
            ? " Skipped: " + res.skipped.slice(0, 6).join(", ") + " — those are not colours of this product."
            : ""));
    });
  }

  /** CSS.escape is not in jsdom, and this runs in a gate. Same rule as
   *  everywhere else here: a shim that is obviously a shim beats a screen that
   *  only works in a browser and cannot be tested. */
  function cssEscape(v) {
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") return CSS.escape(v);
    return String(v).replace(/["\\\]\[\.#:>+~*^$|()=]/g, "\\$&");
  }

  el.querySelector('[data-t="spread"]').addEventListener("click", spreadEvenly);
  el.querySelector('[data-t="curve"]').addEventListener("click", openCurvePanel);
  el.querySelector('[data-t="paste"]').addEventListener("click", openPastePanel);
  el.querySelector('[data-t="clear"]').addEventListener("click", () => {
    snapshot("clear");
    q.clear();
    syncInputs();
    paint();
    say("Every box emptied.");
  });
  undoEl.addEventListener("click", () => {
    if (!undoSnapshot) return;
    const back = undoSnapshot;
    undoSnapshot = null;
    q.clear();
    back.forEach((v, k) => q.set(k, v));
    syncInputs();
    paint();
    say("Put back.");
  });

  billedEl.addEventListener("input", () => { say(""); paint(); });
  el.querySelector('[data-a="cancel"]').addEventListener("click", () => onCancel());

  confirmEl.addEventListener("click", async () => {
    // CNT-03 again, at the last possible moment. The button is already
    // disabled while the two disagree; this is the belt as well as the braces,
    // because a disabled button is a UI state and this is stock and money.
    const b = billed();
    const e = entered();
    if (b <= 0 || e !== b) { paint(); return; }

    const lines = [];
    colours.forEach((c) => sizes.forEach((s) => {
      const n = get(c, s);
      if (!n) return;
      const v = variantAt(product, c, s);
      if (v) lines.push({ variantId: v.id == null ? v.variantId : v.id, colour: c, size: s, qty: n * per });
    }));

    const wasLabel = confirmEl.textContent;
    confirmEl.disabled = true;
    confirmEl.textContent = "Receiving…";
    const locEl = el.querySelector("#rcvp-loc");
    const res = await onConfirm({
      billed: b, total: e, pieces: piecesTotal(), unitsPerBox: per, lines,
      locationId: locEl ? locEl.value : (locations[0] && locations[0].id) || null,
    });
    if (res && res.ok === false) {
      // Stays put with every number still in it. A screen that resets on error
      // makes the person re-count sixteen boxes to find out whether it was
      // their input or the network.
      say(res.error || "That receipt could not be saved. Nothing was changed.");
      confirmEl.disabled = false;
      confirmEl.textContent = wasLabel;
    }
  });

  buildGrid();
  paint();
  return el;
}
