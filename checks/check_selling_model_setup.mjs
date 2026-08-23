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

const dom = new JSDOM("<!doctype html><html><body><div id='app-root'></div></body></html>",
                      { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;

dom.window.supabase = { createClient: () => ({ from: () => ({}), rpc: () => ({}) }) };
if (!dom.window.URL.createObjectURL) dom.window.URL.createObjectURL = () => "blob:x";
globalThis.URL = dom.window.URL;

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

  // ------------------- 5. create mode: honest about ordering ---------------
  {
    const { host, setModel, opened } = build();
    setModel("ratio");
    // Null-safe on purpose. Run against the pre-Batch-8D form this file used
    // to die here with "Cannot read properties of null", reporting NONE of its
    // other findings -- the same "a gate that only throws tells you nothing"
    // trap check_inventory_panes.mjs and the Batch 5 card gate both hit.
    const btn = host()?.querySelector("#pb-open-selling-setup") || null;
    ok(btn?.disabled === true,
       "on a NEW product the button is disabled — a ratio has to belong to a product row, and there is not one yet");
    ok(/create the product first/i.test(btn?.title || "") ||
       /create the product first/i.test(host()?.textContent || ""),
       "…and says why, instead of being a live-looking button that does nothing when pressed");
    btn?.click();
    ok(opened.length === 0, "pressing it while disabled does nothing rather than calling back with a null id");
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
import { readFileSync } from "node:fs";
const view = readFileSync(new URL("../js/views/wholesaler.js", import.meta.url), "utf8");
ok(/async function openSellingSetup\(/.test(view),
   "the view exposes one opener for the builder, rather than three copies of the same closure");
ok((view.match(/onOpenSellingSetup:/g) || []).length === 3,
   "all THREE product-form call sites pass it — Stock pane, Catalogs, and the editor; one missed site is one screen where the button is dead");
ok(/id: loaded\.product\.id/.test(view),
   "the editor hands the product id to the form, without which edit mode could never enable the button");

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
