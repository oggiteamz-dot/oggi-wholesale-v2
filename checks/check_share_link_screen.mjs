// =============================================================================
// GATE — MAKING AND MANAGING A LINK               LINK-02/11, 8 Sep 2026
// =============================================================================
// THE PROPERTIES, in the order they would hurt:
//
//   1. ⭐ AN ACTIONABLE REFUSAL IS SHOWN, NOT TOASTED. Two of the database's
//      refusals tell the wholesaler what to do INSTEAD -- D-2 names the shop
//      that already holds that number, D-5 explains why a forwarded discount
//      is a price list in the wild. A notification that fades after four
//      seconds is the wrong container for an instruction, and the wholesaler
//      is left re-typing the same number.
//
//   2. ⭐ THE FINISHED LINK IS ON THE SCREEN. It is the entire deliverable and
//      it has to be copied somewhere else. AC-03's invite card settled this on
//      29 Aug; the same trade is settled the same way here, including the part
//      where the result is NOT repainted away to refresh the list underneath.
//
//   3. ⭐ "3 of 5 USED" IS A LIE ABOUT A LINK FORTY PEOPLE OPENED. uses_count
//      counts GRANTS, so the people sent to the approval queue are counted
//      separately -- which is the whole reason v2_my_share_links carries
//      requests_count (migration 128 note (d)).
//
//   4. ⭐ THE STATE IS SQL'S. Migration 129 computes one state per link so the
//      browser does not compute four. A view that recomputes it is a second
//      opinion that will drift.
//
//   5. THE FOUR KINDS ARE ALL OFFERED, and each says what it does to the
//      person who opens it. Hadi named four; three of four is a feature that
//      exists in the database and nowhere a wholesaler can reach.
//
//   6. THE ROUTE IS REGISTERED AND THE SIDEBAR IS NOT GROWN. The nine-entry
//      cap is Hadi's requirement, and a new screen of mine is not a reason to
//      raise it -- that is the 25 Aug mistake, writing the gate to match my
//      design instead of his requirement.
//
//   7. DOOR A IS STILL THERE. Retiring v2_buyer_invites is decision D-1 and it
//      is Hadi's. Until he makes it, a screen that quietly replaces the
//      invitation card is a removal nobody approved.
//
// RUN:  node checks/check_share_link_screen.mjs
// =============================================================================
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://check.local/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
// Node 22 defines globalThis.navigator with a getter only, so it cannot be
// assigned. defineProperty is not a workaround for a rule — it is the only way
// to give the copy fallback in the view a clipboard-less navigator to fail
// against, which is the branch worth exercising.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);
const src = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Comments stripped before any "the code never does X" assertion — otherwise a
// file EXPLAINING why it must not recompute the state fails the check for
// recomputing it, and the next person deletes the explanation to go green.
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

const viewFile = await src("../js/views/share-links-admin.js");
const viewSrc = viewFile.split("\n").filter((l) => !l.startsWith("import ")).join("\n");

// ⚠️ The stubs FORWARD LAZILY. import() of a data: URL is cached BY URL and
// every call here builds identical source, so a `const x = globalThis.__x`
// binding would serve the first test's stubs to every later load. That cost an
// hour on check_join_screen.mjs; it is not paid twice.
function loadView(stubs = {}) {
  const shim = `
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pageHeader = (t, s) => { const d = document.createElement("div"); d.textContent = t + " " + (s || ""); return d; };
const emptyState = (o) => { const d = document.createElement("div"); d.setAttribute("data-empty", "1"); d.textContent = (o?.title || "") + " " + (o?.body || ""); return d; };
const toast = (...a) => globalThis.__toast(...a);
const confirmAction = async (...a) => globalThis.__confirm(...a);
const devAuth = { getSession: () => ({ wid: "w1", wholesalerName: "Cedar Textiles" }) };
const listCatalogs = async (...a) => globalThis.__catalogs(...a);
const listMyShareLinks = async (...a) => globalThis.__list(...a);
const createShareLink = async (...a) => globalThis.__create(...a);
const revokeShareLink = async (...a) => globalThis.__revoke(...a);
const shareLinkUrl = (t) => "https://shop.example/#/j/" + t;
const shareLinkWhatsappHref = (t) => "https://wa.me/?text=" + t;
`;
  globalThis.__toast = stubs.toast || (() => {});
  globalThis.__confirm = stubs.confirm || (async () => true);
  globalThis.__catalogs = stubs.catalogs || (async () => []);
  globalThis.__list = stubs.list || (async () => []);
  globalThis.__create = stubs.create || (async () => ({ ok: true, token: "a".repeat(24), expiresAt: "2026-10-08T00:00:00Z" }));
  globalThis.__revoke = stubs.revoke || (async () => ({ ok: true }));
  return import("data:text/javascript;base64," +
    Buffer.from(shim + viewSrc).toString("base64"));
}

const LINK = {
  id: "l1", token: "b".repeat(24), kind: "capped", state: "active",
  inviteeName: null, inviteePhone: null, discountPct: null,
  maxUses: 5, usesCount: 3, requestsCount: 37,
  catalogName: null, note: null,
  expiresAt: "2026-10-08T00:00:00Z", revokedAt: null, createdAt: "2026-09-08T00:00:00Z",
};

const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 0));

// ============================================ 1. AN ACTIONABLE REFUSAL ======
// D-2. The database refuses and NAMES the shop. That sentence has to survive
// onto the screen — a toast would leave the wholesaler with a form that looks
// like it did nothing.
{
  const D2 = "Maison Rita is already your customer on that number. Change their discount on their client record instead — a second link would give them a second account.";
  const toasted = [];
  const outlet = document.createElement("div");
  const { shareLinksView } = await loadView({
    toast: (m) => toasted.push(m),
    create: async () => ({ ok: false, error: D2 }),
  });
  await shareLinksView(outlet);
  click(outlet.querySelector('[data-a="make"]'));
  await settle(); await settle();

  ok(outlet.textContent.includes("Maison Rita is already your customer"),
     "⭐ D-2's refusal is on the screen, naming the shop");
  ok(!toasted.some((m) => String(m).includes("Maison Rita")),
     "⭐ and it is not thrown away into a toast");
  ok(/#\/wholesaler\/clients/.test(outlet.innerHTML),
     "⭐ and it offers the way to the client record it tells them to open");
}

{
  // D-5, and the difference that matters: this refusal is NOT about a
  // particular shop, so it gets no Clients link. A gate that only checked
  // "a refusal is shown" would not notice the screen sending everybody there.
  const D5 = "A discount can only go on a one-person link. Anyone can forward the other kinds, and a rate you agreed with one shop would go with it.";
  const outlet = document.createElement("div");
  const { shareLinksView } = await loadView({ create: async () => ({ ok: false, error: D5 }) });
  await shareLinksView(outlet);
  click(outlet.querySelector('[data-a="make"]'));
  await settle(); await settle();
  ok(outlet.textContent.includes("A discount can only go on a one-person link"),
     "D-5's refusal is shown verbatim");
  ok(!/#\/wholesaler\/clients/.test(outlet.querySelector('[data-slot="out"]').innerHTML),
     "and a refusal about no particular shop does not send them to Clients");
}

// ================================================ 2. THE LINK IS SHOWN ======
{
  const toasted = [];
  const outlet = document.createElement("div");
  const { shareLinksView } = await loadView({ toast: (m) => toasted.push(m) });
  await shareLinksView(outlet);
  click(outlet.querySelector('[data-a="make"]'));
  await settle(); await settle();

  const out = outlet.querySelector('[data-slot="out"]');
  ok(/#\/j\/a{24}/.test(out.textContent), "⭐ the finished link is written on the screen");
  ok(!toasted.some((m) => String(m).includes("#/j/")), "and not toasted");
  ok(!!out.querySelector("a[href^='https://wa.me/']"), "with a WhatsApp button beside it");
  ok(!!out.querySelector('[data-a="copy"]'), "and a copy button");

  // The result survives the list repaint that follows it. Repainting the form
  // would destroy the link to refresh a list sitting underneath — the trade
  // AC-03 refused, in the wrong direction.
  ok(/#\/j\/a{24}/.test(outlet.querySelector('[data-slot="out"]').textContent),
     "⭐ and it is still there after the list underneath is repainted");
}

// ================================ 3. THE QUEUE IS COUNTED SEPARATELY ========
{
  const outlet = document.createElement("div");
  const { shareLinksView } = await loadView({ list: async () => [LINK] });
  await shareLinksView(outlet);
  const t = outlet.textContent;
  ok(t.includes("3 of 5"), "a capped link says how many of its places are gone");
  ok(t.includes("37"), "⭐ and the 37 people waiting on approval are counted, not hidden inside it");
  ok(/#\/wholesaler\/requests/.test(outlet.innerHTML),
     "⭐ and the count is the way through to the queue they are waiting in");
}

// ======================================== 4. THE STATE IS SQL'S ONE ========
{
  const bare = strip(viewSrc);
  ok(!/usesCount\s*>=|uses_count\s*>=|revokedAt\s*!==\s*null\s*\?\s*["']revoked/.test(bare),
     "⭐ the view never recomputes the state migration 129 already computed");
  // Every state SQL can return has a word for it. A state with no label prints
  // its raw database value at a wholesaler, which is how 'full' reaches a
  // human as 'full' rather than 'Full' — or how a new state prints nothing.
  const outlet = document.createElement("div");
  const { shareLinksView } = await loadView({
    list: async () => ["active", "used", "full", "expired", "revoked"].map((state, i) => ({
      ...LINK, id: "l" + i, state, revokedAt: state === "revoked" ? "2026-09-09T00:00:00Z" : null,
    })),
  });
  await shareLinksView(outlet);
  const badges = [...outlet.querySelectorAll(".badge")].map((b) => b.textContent.trim());
  ok(["Live", "Used", "Full", "Expired", "Withdrawn"].every((w) => badges.includes(w)),
     "every state the database can return has a word a wholesaler reads");
  ok([...outlet.querySelectorAll("[data-link-state]")].length === 5,
     "and every link is listed whatever its state — a withdrawn link is a thing that happened");
}

// ==================================== 5. ALL FOUR KINDS ARE OFFERED ========
{
  const outlet = document.createElement("div");
  const { shareLinksView } = await loadView();
  await shareLinksView(outlet);
  const kinds = [...outlet.querySelectorAll("[data-kind]")].map((b) => b.getAttribute("data-kind"));
  ["one_time", "unlimited", "capped", "approval"].forEach((k) => {
    ok(kinds.includes(k), `the "${k}" link can be made from the screen`);
  });
  ok(kinds.length === 4, "and nothing else is offered that the database would refuse");

  // Each one says what it DOES. "Unlimited" and "approval" are indistinguishable
  // as words on a radio button and the whole difference is who gets in without
  // being asked about.
  const blurbs = [...outlet.querySelectorAll("[data-kind]")].map((b) => b.textContent.length);
  ok(Math.min(...blurbs) > 60, "and each explains itself rather than naming itself");
}

{
  // A one-person link takes a phone; the other three do not, and offering a
  // discount box on a link anyone can forward is offering something the
  // database will refuse.
  const outlet = document.createElement("div");
  const { shareLinksView } = await loadView();
  await shareLinksView(outlet);
  ok(!!outlet.querySelector('[data-f="phone"]'), "a one-person link asks for the phone that proves it is them");
  ok(!!outlet.querySelector('[data-f="discount"]'), "and offers the discount only it may carry");

  click([...outlet.querySelectorAll("[data-kind]")].find((b) => b.getAttribute("data-kind") === "unlimited"));
  await settle();
  ok(!outlet.querySelector('[data-f="discount"]'), "an unlimited link offers no discount box");
  ok(!outlet.querySelector('[data-f="phone"]'), "and asks for nobody's number");

  click([...outlet.querySelectorAll("[data-kind]")].find((b) => b.getAttribute("data-kind") === "capped"));
  await settle();
  ok(!!outlet.querySelector('[data-f="max"]'), "a capped link asks how many get in");
}

// ================================= 6. THE ROUTE, AND THE NINE-ENTRY CAP ====
{
  const wsSrc = await src("../js/views/wholesaler.js");
  const navSrc = await src("../js/lib/nav-config.js");
  ok(/registerShareLinkAdminRoutes\(router\)/.test(wsSrc),
     "the screen is registered as a route");
  ok(/router\.register\(\s*["']\/wholesaler\/links["']/.test(viewFile),
     "and /wholesaler/links is the path it registers");

  // THE CAP IS HADI'S REQUIREMENT, so it is asserted against the REAL ARRAY,
  // the way check_inventory_module.mjs already does. My first attempt counted
  // `{ icon:` occurrences in the source and got 13, because six of them are
  // inside the comment recording the six entries Batch 8B folded into
  // Inventory. A regex over source counts the history as well as the list.
  const nav = (await import(new URL("../js/lib/nav-config.js", import.meta.url))).NAV_BY_ROLE.wholesaler;
  ok(nav.length <= 9, `the wholesaler sidebar is still within its nine-entry cap (${nav.length})`);
  ok(!nav.some((e) => e.path === "/wholesaler/links"), "and this screen did not take one of those nine");
  ok(!/wholesaler\/links/.test(navSrc), "not even commented into the navigation for somebody to uncomment");

  // Unreachable is the same as absent. /c/:token was registered and unreachable
  // for three weeks; a screen with no nav entry AND no door is that bug again.
  ok(/#\/wholesaler\/links/.test(wsSrc), "and there is a door to it from another screen");
}

// ============================================= 7. DOOR A IS STILL THERE ====
{
  const wsSrc = await src("../js/views/wholesaler.js");
  ok(/issueInvite\b/.test(wsSrc) && /listMyInvites\b/.test(wsSrc),
     "Door A — the invitation card — is untouched; retiring it is D-1 and it is Hadi's");
  ok(/data-a="new"/.test(wsSrc), "and its create button is still on the Clients screen");
}

// =============================================================================
console.log(`\n  ${pass.length} passed, ${fail.length} failed\n`);
pass.forEach((m) => console.log("  ✓ " + m));
fail.forEach((m) => console.log("  ✗ " + m));
if (fail.length) { console.log("\n  LINK-02/11 GATE RED\n"); process.exit(1); }
console.log("\n  LINK-02/11 GATE GREEN\n");
