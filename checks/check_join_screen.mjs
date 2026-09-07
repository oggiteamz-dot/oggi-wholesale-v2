// =============================================================================
// GATE — JOINING THROUGH A LINK, CLIENT SIDE            LINK-05/10, 8 Sep 2026
// =============================================================================
// THE PROPERTIES, in the order they would hurt:
//
//   1. ⭐ THE SCREEN NEVER GREETS THEM BY NAME. A one-person link is sent to
//      one number on WhatsApp and WhatsApp messages get forwarded. "Hi Rita"
//      on a forwarded link publishes, to whoever it reaches, a fact the
//      wholesaler told exactly one person. The database will not return
//      invitee_name (migration 129); this proves the browser does not invent a
//      substitute.
//
//   2. ⭐ NOBODY WHO OPENS A REAL LINK IS SHOWN A WALL. Every live link --
//      whatever its kind, used up or not -- renders THE SAME FORM. Only the
//      sentence above it changes. Hadi: "either way, they get access and they
//      are logged in."
//
//   3. ⭐ A NETWORK FAILURE IS NOT A DEAD LINK. Telling somebody with a
//      perfectly good link to go and ask for a new one is worse than telling
//      them nothing, so the two have different screens.
//
//   4. THE SESSION IS ADOPTED BY THE DATA MODULE, NOT THE VIEW. A view that
//      forgets the call leaves somebody the SERVER signed in signed out in the
//      browser -- the "signed up to the marketplace itself" promise failing
//      silently in the one place nothing would notice.
//
//   5. THE ROUTE IS PUBLIC. /j/:token is registered AND isPublicPath says so.
//      Registering without the second is the bug that made /c/:token
//      unreachable for three weeks: app.js renders the login screen and
//      returns before any route is registered.
//
//   6. `v2:after-login` IS READ. It has been written since 29 Aug and never
//      read, so the promise its own comment makes -- "come back here
//      afterwards rather than dumping them on a dashboard" -- was never kept.
//
// RUN:  node checks/check_join_screen.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Comments are stripped before any "the code never mentions X" assertion.
// Without this, a file EXPLAINING why it must not read the invitee fails the
// check for reading them -- which would push the next person to delete the
// explanation to make the gate pass. The explanation is the more valuable half.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

// The view imports the data module, which imports the supabase client. Neither
// belongs in this gate, so the view is loaded from source with its imports
// replaced by stubs -- the same trick, and the same reason, as testing a
// formatter without a network.
const viewSrc = (await src("../js/views/join.js"))
  .split("\n").filter((l) => !l.startsWith("import ")).join("\n");

// ⚠️ THE STUBS FORWARD LAZILY, AND THAT IS NOT A STYLE CHOICE.
//
// The first version of this helper wrote
//     const peekShareLink = globalThis.__peek;
// which binds ONCE, at module evaluation. `import()` of a data: URL is CACHED
// by URL, and every call here builds the identical source -- so the second
// `loadView` returned the FIRST module, still holding the first test's stubs.
// The symptom was baffling: the refusal test found no form, because it had
// silently re-run the previous test's success path and replaced the outlet.
//
// Forwarding through a function reads the current stub on every call, so one
// cached module serves every case correctly. (Appending a unique comment to
// bust the cache would also work and is worse: it hides the sharp edge instead
// of removing it, and the next person writes the binding version again.)
function loadView({ peek, redeem }) {
  const stub = `
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peekShareLink = (...a) => globalThis.__peek(...a);
const redeemShareLink = (...a) => globalThis.__redeem(...a);
`;
  globalThis.__peek = peek;
  globalThis.__redeem = redeem;
  return import("data:text/javascript;base64," +
    Buffer.from(stub + viewSrc).toString("base64"));
}

const LIVE = {
  status: "ok", wid: "zz", wholesalerName: "Cedar Textiles", kind: "one_time",
  hint: "phone_must_match",
  msg: "Cedar Textiles sent this to one number. Sign up with that number and you are straight in; with any other, they will be asked to approve you.",
};

// ===================================================== 1. IT NAMES NOBODY ====
// The peek is given a row that carries NO invitee at all, because the database
// does not return one. The screen must not go looking for one either.
{
  const outlet = document.createElement("div");
  const { joinView } = await loadView({
    peek: async () => LIVE,
    redeem: async () => ({ ok: true, outcome: "joined", wholesalerName: "Cedar Textiles", msg: "" }),
  });
  await joinView(outlet, { token: "abc" });
  const html = outlet.innerHTML;
  ok(html.includes("Cedar Textiles"), "the screen leads with the wholesaler's name");
  ok(!/invitee/i.test(strip(viewSrc)), "⭐ the view never reads an invitee field at all");
  ok(!/Hi \$\{/.test(viewSrc) && !/\bHi \w/.test(html), "⭐ and it never greets anybody by name");
}

// ================================== 2. A LIVE LINK ALWAYS SHOWS THE FORM ====
// All three hints, and both a fresh and a used-up link. There is no state of
// this screen where somebody holding a real link is shown a wall.
{
  for (const hint of ["immediate", "phone_must_match", "needs_approval"]) {
    const outlet = document.createElement("div");
    const { joinView } = await loadView({
      peek: async () => ({ ...LIVE, hint }),
      redeem: async () => ({ ok: true, outcome: "joined" }),
    });
    await joinView(outlet, { token: "abc" });
    const form = outlet.querySelector("form");
    ok(!!form, `⭐ hint "${hint}" still shows the sign-up form, never a wall`);
    ok(!!outlet.querySelector('[name="phone"]') && !!outlet.querySelector('[name="password"]'),
       `hint "${hint}" asks for the phone and a password`);
  }
}

// =============================== 3. DEAD, AND NOT-REACHABLE, ARE DIFFERENT ===
{
  const outlet = document.createElement("div");
  const { joinView } = await loadView({
    peek: async () => ({ status: "unavailable", msg: "This link is no longer active. Ask whoever sent it to you for a new one." }),
    redeem: async () => ({ ok: false }),
  });
  await joinView(outlet, { token: "abc" });
  ok(!outlet.querySelector("form"), "a dead link shows no form");
  ok(outlet.textContent.includes("no longer active"), "...and renders the server's own sentence");
  ok(!outlet.textContent.includes("Cedar"), "...and names no store");
}
{
  const outlet = document.createElement("div");
  const { joinView } = await loadView({
    peek: async () => ({ status: "error", msg: "Could not open this link just now. Check your connection and try again." }),
    redeem: async () => ({ ok: false }),
  });
  await joinView(outlet, { token: "abc" });
  ok(outlet.textContent.includes("couldn't reach"),
     "⭐ a network failure says so, instead of calling a good link dead");
  ok(!!outlet.querySelector('[data-a="retry"]'), "...and offers to try again");
}

// ================================== 4. THE THREE ENDINGS, EACH ACTIONABLE ====
{
  for (const [outcome, needle] of [["joined", "You're in"],
                                   ["requested", "signed up to OGGI"],
                                   ["already", "already shop here"]]) {
    const outlet = document.createElement("div");
    const { joinView } = await loadView({
      peek: async () => LIVE,
      redeem: async () => ({ ok: true, outcome, wholesalerName: "Cedar Textiles", msg: "" }),
    });
    await joinView(outlet, { token: "abc" });
    const form = outlet.querySelector("form");
    form.querySelector('[name="shop"]').value = "Rita Boutique";
    form.querySelector('[name="phone"]').value = "03 456 789";
    form.querySelector('[name="username"]').value = "ritab";
    form.querySelector('[name="password"]').value = "hunter2secret";
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    ok(outlet.textContent.includes(needle), `outcome "${outcome}" ends on a screen that says what happened`);
    ok(!/error/i.test(outlet.textContent), `outcome "${outcome}" never says "error"`);
  }
}

// ============================== 5. A REFUSAL KEEPS THEM ON THE FORM ==========
// The server's words, and the form still filled in. Wiping it would make a
// taken username cost them everything they typed.
{
  const outlet = document.createElement("div");
  const { joinView } = await loadView({
    peek: async () => LIVE,
    redeem: async () => ({ ok: false, error: "That username is taken for this store. Try another." }),
  });
  await joinView(outlet, { token: "abc" });
  const form = outlet.querySelector("form");
  form.querySelector('[name="shop"]').value = "Rita Boutique";
  form.querySelector('[name="phone"]').value = "03 456 789";
  form.querySelector('[name="username"]').value = "taken";
  form.querySelector('[name="password"]').value = "hunter2secret";
  form.dispatchEvent(new dom.window.Event("submit", { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  ok(outlet.querySelector('[data-slot="msg"]').textContent.includes("taken"),
     "a refusal shows the server's own sentence");
  ok(!!outlet.querySelector("form"), "...and leaves them on the form");
  ok(outlet.querySelector('[name="shop"]').value === "Rita Boutique",
     "...with what they typed still in it");
  ok(!outlet.querySelector(".inv-go").disabled, "...and the button usable again");
}

// ================ 6. THE DATA MODULE ADOPTS THE SESSION, NOT THE VIEW =======
{
  const dataSrc = await src("../js/data/share-links.js");
  ok(/adoptMarketplaceSession\(/.test(dataSrc),
     "⭐ redeeming adopts the session the server minted");
  ok(!/adoptMarketplaceSession|localStorage/.test(viewSrc),
     "...and the view does not touch session storage itself");
  ok(/from "\.\/marketplace\.js"/.test(dataSrc),
     "...through the one module that owns the storage key");
  // A token the browser made would be a token the database never issued.
  ok(!/gen_random|Math\.random|crypto\.(getRandomValues|randomUUID)/.test(dataSrc),
     "the browser never generates a link token");
}

// ============================ 7. THE ROUTE IS REGISTERED *AND* PUBLIC =======
{
  const pub = await src("../js/views/public-order.js");
  ok(/router\.register\("\/j\/:token"/.test(pub), "/j/:token is registered");
  ok(/\\\/j\\\/\[\^\/\]\+\$/.test(pub) || /\/\^\\\/j/.test(pub) || pub.includes("/^\\/j\\/[^/]+$/"),
     "⭐ ...and isPublicPath says it needs no session");
  // The pairing is the property. Registering without the second is the bug
  // that left /c/:token unreachable for three weeks.
  const registered = (pub.match(/router\.register\("\/(\w)\/:token"/g) || []).map((m) => m.match(/\/(\w)\//)[1]);
  const publicIsh = (pub.match(/\/\^\\\/(\w)\\\/\[\^\/\]\+\$\//g) || []).map((m) => m.match(/\\\/(\w)\\\//)[1]);
  ok(registered.every((r) => publicIsh.includes(r)),
     `every public route registered is also in isPublicPath (${registered.join(",")} vs ${publicIsh.join(",")})`);
}

// ==================== 8. `v2:after-login` IS FINALLY READ ===================
{
  const app = await src("../js/app.js");
  ok(/sessionStorage\.getItem\("v2:after-login"\)/.test(app),
     "⭐ app.js reads the destination somebody was trying to reach");
  ok(/sessionStorage\.removeItem\("v2:after-login"\)/.test(app),
     "...and clears it, so a stale destination cannot reopen itself days later");
  ok(/router\.matches\(back\)/.test(app),
     "...and only uses it if it still resolves to a real route");
}

// =============================================================================
console.log("\n" + "=".repeat(64));
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
console.log("-".repeat(64));
if (fail.length) {
  console.log(` ✗ FAIL — ${fail.length} of ${pass.length + fail.length} assertions failed.`);
  process.exit(1);
}
console.log(` ✓ PASS — ${pass.length} assertions.`);
