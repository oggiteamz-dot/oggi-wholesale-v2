// =============================================================================
// CHECK: choosing a selling model tells you what it costs you    (Batch 8D)
// =============================================================================
// Hadi, 23 August 2026:
//
//   "Create a button at the end of the product creation page. So if I pick
//    ratio, then at the end, it automatically generates a button that says
//    set ratios... I have zero ways of actually opening this up. I think
//    you're thinking that there's going to be an AI building this. No, it's
//    going to be a human. So it needs to be manual."
//
// THE BUG UNDERNEATH THE MISSING BUTTON
// -------------------------------------
// v2_enforce_selling_model refuses any LOOSE order for a ratio, prepack or
// series product. If the product has no pack, the buyer cannot choose one
// either -- refused BOTH ways, silently unsellable.
//
// Measured on production, 23 Aug 2026, Hadi's own wholesaler:
//
//     guyhj    ratio     28 variants   0 packs
//     htfd     prepack   18 variants   0 packs
//
// Both unorderable from the moment their model was set, by this very form,
// which said nothing about it.
//
// WHAT THIS ASSERTS
// -----------------
// The form is rendered in a real DOM and the dropdown is actually changed,
// then the DOM is read. Not a source grep: the question is what a human sees
// after picking "Ratio", and a string existing somewhere in the file has
// already been proven insufficient twice in this project.
//
// Proven red: reverting paintSellingSetup fails assertions 2-7.
//
//   node checks/check_selling_model_setup.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const dom = new JSDOM("<!doctype html><html><body><div id='app-root'></div></body></html>",
                      { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;

dom.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };
if (!dom.window.URL.createObjectURL) dom.window.URL.createObjectURL = () => "blob:x";
globalThis.URL = dom.window.URL;
// jsdom does not implement scrollIntoView -- it does not lay out, so there is
// nothing to scroll. Every browser has it. Polyfilled as a no-op so the
// post-save path can be exercised here; without this the gate dies with
// "scrollIntoView is not a function" and reports nothing, which is the trap
// this file already carries a note about.
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

async function load(path, label) {
  try { return await import(path); }
  catch (e) { fail.push(`${label} — could not be loaded: ${String(e).split("\n")[0]}`); return null; }
}

const mod = await load("../js/components/product-form.js", "js/components/product-form.js");
const renderProductForm = mod?.renderProductForm;
ok(!!renderProductForm, "renderProductForm() loads");

// ------------------------------------------------- helper: build and drive --
function build(opts = {}) {
  const opened = [];
  const form = renderProductForm({
    locations: [{ id: "loc-1", name: "Main", is_default: true }],
    suppliers: [],
    onOpenSellingSetup: (pid, model) => opened.push({ pid, model }),
    ...opts,
  });
  document.getElementById("app-root").innerHTML = "";
  document.getElementById("app-root").appendChild(form.el);
  const el = form.el;
  const setModel = (v) => {
    const sel = [...el.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "ratio"));
    sel.value = v;
    sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const host = () => el.querySelector("#pb-selling-setup");
  return { el, setModel, host, opened, form };
}

if (renderProductForm) {
  // ------------------------------------------------------ 1. open = quiet --
  {
    const { host, setModel } = build();
    setModel("open");
    ok(host() && host().hidden === true,
       "picking Open shows nothing extra — open stock needs no setup, and a panel that is always there stops being read");
  }

  // ------------------------------------------------- 2. ratio = a button ---
  {
    const { host, setModel } = build();
    setModel("ratio");
    const h = host();
    ok(h && h.hidden === false, "picking Ratio reveals a section at the end of the form");
    const btn = h?.querySelector("#pb-open-selling-setup");
    ok(!!btn && /set ratios/i.test(btn.textContent || ""),
       'and a button that says "Set ratios" — the thing that did not exist, so the builder had no door from here');
    ok(!!h && /cannot order it/i.test(h.textContent || ""),
       "and states the consequence out loud: buyers cannot order it until it has one");
  }

  // ---------------------------------------------- 3. prepack = a button ----
  {
    const { host, setModel } = build();
    setModel("prepack");
    const btn = host()?.querySelector("#pb-open-selling-setup");
    ok(!!btn && /set prepacks/i.test(btn.textContent || ""),
       'picking Prepack gives "Set prepacks" — same door, named for what it opens');
  }

  // ------------------------------- 4. series = NO button, and says why -----
  {
    const { host, setModel } = build();
    setModel("series");
    const h = host();
    ok(h && h.hidden === false, "picking Series shows the section");
    ok(!h?.querySelector("#pb-open-selling-setup"),
       "…but NO button — a series is every colour and size at one each, so there is nothing for a human to choose, and migration 079's trigger builds it");
    ok(!!h && /automatically/i.test(h.textContent || ""),
       "…and it says so, rather than leaving someone hunting for a setup step that does not exist");
  }

  // ------- 5. create mode: the button WORKS, it does not refuse ------------
  // CHANGED 23 Aug 2026 (Batch 8E). This block used to assert the opposite --
  // that the button is `disabled` on a new product. That assertion was green,
  // and it was guarding the bug:
  //
  //   Hadi: "the button to set a ratio is broken and doesn't allow me to do
  //   anything. Like, it's faded out, and whenever I hover over it, it gives
  //   me the stop sign."
  //
  // A gate can be perfectly correct about behaviour that should never have
  // shipped. Worth recording, because the temptation on seeing it go red was
  // to "fix the test" -- when the test was the thing describing the defect.
  {
    // Null-safe on purpose. Run against a form with no section at all this
    // file used to die here with "Cannot read properties of null", reporting
    // NONE of its other findings.
    const { host, setModel, opened } = build();
    setModel("ratio");
    const btn = host()?.querySelector("#pb-open-selling-setup") || null;
    ok(btn?.disabled === false,
       "on a NEW product the button is NOT disabled — a greyed button with a no-entry cursor reads as broken, whatever the caption underneath says");
    ok(/saves the product first/i.test(host()?.textContent || ""),
       "…and it says what pressing it will do: save the product, then open the builder");
    ok(!/create the product first/i.test(host()?.textContent || ""),
       "…and no longer tells the person to go and do the step themselves");
  }

  // ------- 5b. pressing it on a new product ATTEMPTS the save --------------
  // Not asserted by faking a successful save: validate() legitimately requires
  // a name, a named colour and at least one size, and a gate that drove all of
  // that through the DOM would be testing the colour grid, not this button.
  //
  // What is asserted is the thing that actually changed. BEFORE the fix the
  // handler opened with
  //
  //     if (!savedProductId) return;
  //
  // so a click on a new product did NOTHING -- no save, no validation, no
  // message, which is exactly why it read as broken. Now the click reaches
  // doSave(), and doSave() runs validate(), and validate() puts a reason on
  // screen. A visible validation error is therefore proof the click got
  // through, and its absence is proof it did not.
  {
    const { el, host, setModel } = build();
    setModel("ratio");
    const before = [...el.querySelectorAll(".pf-error")].filter((n) => !n.hidden).length;
    host()?.querySelector("#pb-open-selling-setup")?.click();
    await new Promise((r) => setTimeout(r, 60));
    const after = [...el.querySelectorAll(".pf-error")].filter((n) => !n.hidden).length;
    ok(after > before,
       "pressing it on an empty new product runs the real save path and says what is missing — before this fix the click returned immediately and nothing happened at all");
  }

  // The ordering matters: save FIRST, then open, and open with the id the save
  // returned rather than the stale one the closure captured.
  {
    const src = readFileSync(new URL("../js/components/product-form.js", import.meta.url), "utf8");
    const i = src.indexOf('btn.id = "pb-open-selling-setup"');
    const handler = i >= 0 ? src.slice(i, i + 1800) : "";
    ok(/const res = await doSave\(\);/.test(handler),
       "the button awaits the same doSave() the Save button uses — one save path, not a second half-copy of it");
    ok(/if \(res\?\.ok && res\.productId\) onOpenSellingSetup\(res\.productId, model\)/.test(handler),
       "…and opens the builder only if that save actually succeeded, using the id it returned");
    ok(!/if \(!savedProductId\) return;/.test(handler),
       "…and no longer returns silently when there is no product yet, which is what made it look broken");
  }

  // ------------------- 6. edit mode: live immediately ----------------------
  {
    const { host, setModel, opened } = build({
      initial: { id: "prod-1", name: "Tee", sellingModel: "ratio", variants: [] },
    });
    const h = host();
    ok(h && h.hidden === false && !!h.querySelector("#pb-open-selling-setup"),
       "opening an EXISTING ratio product shows the section straight away, without touching the dropdown");
    const btn = h?.querySelector("#pb-open-selling-setup") || null;
    ok(btn?.disabled === false, "…and the button is live, because the product already exists");
    btn?.click();
    ok(opened.length === 1 && opened[0].pid === "prod-1" && opened[0].model === "ratio",
       "…and pressing it opens the builder for THAT product and THAT model");
  }
}

// ---------------------------------------------------- 7. the wiring holds --
const view = readFileSync(new URL("../js/views/wholesaler.js", import.meta.url), "utf8");
ok(/async function openSellingSetup\(/.test(view),
   "the view exposes one opener for the builder, rather than three copies of the same closure");
ok((view.match(/onOpenSellingSetup:/g) || []).length === 3,
   "all THREE product-form call sites pass it — Stock pane, Catalogs, and the editor; one missed site is one screen where the button is dead");
ok(/id: loaded\.product\.id/.test(view),
   "the editor hands the product id to the form, without which edit mode could never enable the button");

// ---------------- 8. every pane that lists products can make one ----------
// Batch 8E. Hadi: "I can't create a product anymore in the products tab."
// True since Batch 6 folded the standalone Products screen into Inventory:
// the create button lived only on the STOCK pane. The tab actually named
// "Products" had none -- and with zero products it returned early on an empty
// state, so the one moment you most need to create one was the one moment
// nothing offered to.
ok(/function mountNewProductBar\(/.test(view),
   'there is ONE "+ New product" bar, shared — two inline copies of a form this size is how one of them quietly stops passing onOpenSellingSetup');
// Lookbehind excludes the FUNCTION DECLARATION, which also reads
// "mountNewProductBar(outlet". Without it this assertion counted the
// definition as a call site and stayed green with only ONE pane wired --
// caught while proving this very gate red, and precisely the kind of false
// green that let two of this batch's bugs ship.
ok((view.match(/(?<!function )mountNewProductBar\(outlet/g) || []).length >= 2,
   "…mounted by BOTH the Stock pane and the Products pane, counting real call sites and not the declaration");

const prodPane = (() => {
  const i = view.indexOf("async function productsPane(");
  if (i < 0) return "";
  let j = view.indexOf("{", i), d = 0;
  for (let k = j; k < view.length; k++) {
    if (view[k] === "{") d++;
    else if (view[k] === "}") { d--; if (d === 0) return view.slice(i, k + 1); }
  }
  return "";
})();
ok(/mountNewProductBar\(outlet/.test(prodPane),
   "the Products pane mounts it — anchored to that function's byte range, so a match elsewhere in a 200KB file cannot pass this");
ok(prodPane.indexOf("mountNewProductBar(outlet") < prodPane.indexOf("if (!products.length)"),
   "…BEFORE the empty-state return, because no products at all is exactly when you need to add one");

// The Stock pane used to repaint itself on save, destroying the form and the
// button that had just appeared on it.
ok(/const needsSetup = draft\.sellingModel === "ratio" \|\| draft\.sellingModel === "prepack"/.test(view),
   "the Stock pane no longer throws you back to a list straight after creating a product that cannot be sold yet");

// ---------------------------------------------------------------- report ----
const line = "-".repeat(64);
console.log("\nPicking a selling model says what it costs you, and opens the builder\n" + line);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log(line);
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.\n`);
  process.exit(1);
}
console.log(` ✓ PASS — all ${pass.length} assertions held.\n`);
