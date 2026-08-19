// OGGI Wholesale v2 — the read-only product view (Batch 19)
//
// Hadi: "I can't edit the product at all. Maybe there's a mistake. Maybe I
// want to look at the data. So give me a button to essentially edit or a
// button to view or both." Both, and they are deliberately different things.
//
// The editor is for when you already know what is wrong. This is for the
// question that comes first -- is this the right product, what did we pay for
// it, why did the scanner not find it, which warehouse is the shortfall in.
// Answering those inside a form is how accidental edits happen: every field is
// live, every stray keystroke is a change, and the person came to READ.
//
// So nothing here is an input. It shows more than the form does, precisely
// because it is safe to: cost per variant, stock split by location, and all
// three barcode tiers side by side, which is the only view in the app where
// you can see WHY a scan resolved to what it did.

import { esc, money } from "../lib/utils.js";
import { openGallery } from "./image-gallery.js";

const MODEL_LABEL = {
  open: "Open — any quantity of any variant",
  ratio: "Ratio — sizes bought in a fixed proportion",
  prepack: "Prepack — sold only as whole packs",
  series: "Series — the whole size run or nothing",
};

function row(label, value) {
  if (value === null || value === undefined || value === "" ||
      (Array.isArray(value) && !value.length)) return "";
  const shown = Array.isArray(value) ? value.join(", ") : value;
  return `<div class="pdet-row"><dt>${esc(label)}</dt><dd>${esc(String(shown))}</dd></div>`;
}

/** A barcode, or an explicit statement that there isn't one. A blank cell in a
 *  barcode table is ambiguous between "none set" and "failed to load", and the
 *  difference matters when someone is standing at a scanner. */
function code(value) {
  return value
    ? `<code class="pdet-code">${esc(value)}</code>`
    : `<span class="pdet-none">not set</span>`;
}

/**
 * @param {object} detail  the shape returned by getProductDetail()
 * @param {object} [o]
 * @param {Function} [o.onEdit]   shown as a button in the header when given
 * @param {Function} [o.onClose]
 */
export function renderProductDetail(detail, { onEdit, onClose } = {}) {
  const { product, supplier, images, variants, colourBarcodes, archivedVariantCount } = detail;

  const el = document.createElement("div");
  el.className = "card pdet";

  // ---- header -------------------------------------------------------
  const head = document.createElement("div");
  head.className = "pdet-head";
  const heading = document.createElement("div");
  heading.innerHTML = `<h4>${esc(product.name)}${product.archived ? ' <span class="badge badge-neutral">Archived</span>' : ""}</h4>
    <p>${variants.length} colour/size combination${variants.length === 1 ? "" : "s"}${
      archivedVariantCount ? ` · ${archivedVariantCount} archived` : ""
    }</p>`;
  head.appendChild(heading);

  const headActions = document.createElement("div");
  headActions.className = "pdet-head-actions";
  if (onEdit) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-primary btn-sm pdet-edit";
    editBtn.textContent = "Edit this product";
    editBtn.addEventListener("click", () => onEdit());
    headActions.appendChild(editBtn);
  }
  if (onClose) {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn btn-ghost btn-sm pdet-close";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => onClose());
    headActions.appendChild(closeBtn);
  }
  head.appendChild(headActions);
  el.appendChild(head);

  // ---- photos -------------------------------------------------------
  if (images.length) {
    const strip = document.createElement("div");
    strip.className = "pdet-photos";
    images.forEach((url, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pdet-photo";
      b.setAttribute("aria-label", `Photo ${i + 1} of ${images.length}`);
      b.innerHTML = `<img src="${esc(url)}" alt="" loading="lazy">`;
      b.addEventListener("click", () => openGallery(images, i, product.name));
      strip.appendChild(b);
    });
    el.appendChild(strip);
  }

  // ---- the product itself -------------------------------------------
  const facts = document.createElement("dl");
  facts.className = "pdet-facts";
  facts.innerHTML = [
    row("Category", product.category),
    row("Selling model", MODEL_LABEL[product.selling_model] || product.selling_model),
    row("Minimum order", product.moq_qty ? `${product.moq_qty} unit${product.moq_qty === 1 ? "" : "s"}` : ""),
    row("Description", product.description),
  ].join("");
  if (facts.innerHTML) el.appendChild(facts);

  // ---- supplier -----------------------------------------------------
  const sup = document.createElement("section");
  sup.className = "pdet-section";
  if (supplier) {
    sup.innerHTML = `<h5>Supplier</h5>
      <dl class="pdet-facts">${[
        row("Name", supplier.name),
        row("Contact", [supplier.contactName, supplier.phone].filter(Boolean).join(" · ")),
        row("Where", [supplier.address, supplier.country].filter(Boolean).join(", ")),
        row("Sells", supplier.sells),
        row("Brands", supplier.brands),
        row("Lead time", supplier.leadTime),
        row("Their minimum", supplier.moq),
        row("Payment terms", supplier.paymentTerms),
        row("Reference", supplier.refCode),
      ].join("")}</dl>`;
  } else {
    sup.innerHTML = `<h5>Supplier</h5><p class="pdet-none">No supplier recorded on this product.</p>`;
  }
  el.appendChild(sup);

  // ---- barcodes: all three tiers, together ---------------------------
  // Seeing them together is the whole point. A scan that resolves to seven
  // variants instead of one is not a bug in the scanner -- it is a colour-tier
  // code doing exactly what it was asked to. That is only legible if the three
  // tiers are on screen at once.
  const bc = document.createElement("section");
  bc.className = "pdet-section";
  const colourRows = colourBarcodes.length
    ? colourBarcodes.map((cb) => `<div class="pdet-row"><dt>${esc(cb.color || "—")}</dt><dd>${code(cb.barcode)}</dd></div>`).join("")
    : `<p class="pdet-none">No colour-level barcodes.</p>`;
  bc.innerHTML = `<h5>Barcodes</h5>
    <div class="pdet-row"><dt>Whole product</dt><dd>${code(product.barcode)}</dd></div>
    <div class="pdet-subhead">Per colour</div>
    ${colourRows}
    <div class="pdet-subhead">Per size — in the table below</div>`;
  el.appendChild(bc);

  // ---- variants ------------------------------------------------------
  const vs = document.createElement("section");
  vs.className = "pdet-section";
  vs.innerHTML = `<h5>Colours &amp; sizes</h5>`;
  if (!variants.length) {
    vs.innerHTML += `<p class="pdet-none">This product has no live variants.</p>`;
  } else {
    variants.forEach((v) => {
      const item = document.createElement("div");
      item.className = "pdet-variant";
      const swatch = v.colourHex
        ? `<span class="pdet-swatch" style="background:${esc(v.colourHex)}" aria-hidden="true"></span>`
        : "";
      const byLocation = v.stock.length
        ? v.stock.map((s) => `<li>${esc(s.locationName)}: <strong>${s.available}</strong> available${
            s.reserved ? ` (${s.reserved} held)` : ""
          } of ${s.onHand} on hand</li>`).join("")
        : `<li class="pdet-none">Never received into stock.</li>`;
      item.innerHTML = `
        <div class="pdet-variant-head">
          ${swatch}<strong>${esc(v.colour || "—")} / ${esc(v.size || "—")}</strong>
          <span class="pdet-sku">SKU ${esc(v.sku)}</span>
        </div>
        <dl class="pdet-facts">
          ${row("Wholesale price", v.price == null ? "" : money(v.price))}
          ${row("Cost", v.cost == null ? "" : money(v.cost))}
          ${row("Suggested retail", v.retailPrice == null ? "" : money(v.retailPrice))}
          ${row("Minimum", v.moqQty ? `${v.moqQty}` : "")}
          <div class="pdet-row"><dt>Size barcode</dt><dd>${code(v.sizeBarcode)}</dd></div>
          <div class="pdet-row"><dt>Colour barcode</dt><dd>${code(v.colourBarcode)}</dd></div>
        </dl>
        <ul class="pdet-stock">${byLocation}</ul>
      `;
      vs.appendChild(item);
    });
  }
  el.appendChild(vs);

  return el;
}
