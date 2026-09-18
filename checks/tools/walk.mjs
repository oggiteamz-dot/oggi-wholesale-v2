// =============================================================================
// THE WALKER — every screen, every role, against the REAL database
// =============================================================================
// Serves the working tree and drives it in a real Chromium, signed in as the
// six demo roles, visiting all 46 declared routes. Captures a screenshot, the
// page errors, the console errors and a text digest per screen.
//
// It uses the LIVE demo data (six wholesalers, 127 products, 1,820 variants)
// rather than fixtures, because this repo's own history says database-right is
// not screen-right: sizes in Postgres row order, grey swatches, an unstyled
// public outlet -- none of which a fixture would have reproduced.
//
// IT NEVER WRITES. No cart adds, no form submits. Reservations and orders are
// real rows on a real tenant's data.
//
// Sessions: buyer and sales sign in through the app's own RPC-backed login.
// owner / warehouse / finance have no demo password, so their session object is
// injected into localStorage BY THE HARNESS. Deliberately not a bypass shipped
// in the app: a localhost-only backdoor in production code is one bad deploy
// away from being a real backdoor.
//   usage: node tools/walk.mjs <outDir> [label]
// =============================================================================
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES, TOTAL } from "./routes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = process.argv[2];
const LABEL = process.argv[3] || "walk";
const WIDTH = Number(process.env.WALK_WIDTH || 1280);
const HEIGHT = Number(process.env.WALK_HEIGHT || 900);
mkdirSync(OUT, { recursive: true });

const PW = "OggiDemo-2026";
const WID = "demo-meridian";
const MIME = { ".html":"text/html",".css":"text/css",".js":"text/javascript",".json":"application/json",
  ".woff2":"font/woff2",".png":"image/png",".svg":"image/svg+xml",".ico":"image/x-icon",".webmanifest":"application/manifest+json" };

const srv = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = join(ROOT, p);
  if (!existsSync(f) || f.endsWith("/")) { res.writeHead(404); return res.end("nf"); }
  res.writeHead(200, { "Content-Type": MIME[extname(f)] || "text/plain" });
  res.end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, r));
// WALK_BASE POINTS THIS AT THE DEPLOYED SITE.                   19 Sep 2026
// Worth its three lines: four defects survived a clean walk of the working
// tree and only appeared when the same walk was run against the live deploy.
// Left unset, it serves this working tree exactly as before.
const BASE = process.env.WALK_BASE || `http://localhost:${srv.address().port}`;

const browser = await chromium.launch();
const report = { label: LABEL, width: WIDTH, at: new Date().toISOString(), screens: [] };

/** Put a session straight into storage for the roles with no demo password. */
async function injectSession(page, session) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate((s) => localStorage.setItem("oggi-v2-dev-session", JSON.stringify(s)), session);
  // RELOAD. dev-auth.js resolves the session exactly once, in bootstrap(),
  // and app.js awaits that before its first render -- so a session written
  // after boot is never read and the app sits on the sign-in screen. The
  // first run of this walker lost owner, warehouse and finance to that,
  // silently: three roles, 11 screens, all reporting "226 chars" which is
  // the login screen's own length.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  return { session };
}

/** Sign in through the app's own login screen, the way a person does.
 *  Field ids are the REAL ones, read off the running app by
 *  checks/tools/probe-login.mjs -- the first version of this guessed the
 *  order of whatever inputs happened to be visible and silently logged the
 *  buyer into nothing. */
const FORMS = {
  // Field ids read off the running app by checks/tools/probe-login.mjs, and
  // credentials verified by calling the login RPCs directly
  // (checks/tools/probe-auth.mjs) BEFORE trusting any form. That order matters:
  // the first version of this walker guessed the field order, logged nobody in,
  // and reported four roles as "226 chars" -- which is the sign-in screen's own
  // length, not an empty screen. A harness that fails silently is worse than no
  // harness, because it produces a report.
  owner:      { tab: "Owner / Wholesaler",  fields: [["email", "demo-owner@oggiwholesale.app"], ["password", PW]] },
  wholesaler: { tab: "Owner / Wholesaler",  fields: [["email", "demo-meridian@oggiwholesale.app"], ["password", PW]] },
  sales:      { tab: "Sales team",          fields: [["#sales-user", "rep-meridian"], ["#sales-pass", PW]] },
  buyer:      { tab: "Buyer",               fields: [["#mkt-id", "03 999 000"], ["#mkt-pass", PW]] },
  warehouse:  { tab: "Warehouse / Finance", fields: [["#staff-wid", WID], ["#staff-user", "wh-meridian"], ["#staff-pass", PW]] },
  finance:    { tab: "Warehouse / Finance", fields: [["#staff-wid", WID], ["#staff-user", "fin-meridian"], ["#staff-pass", PW]] },
};

async function signIn(page, kind) {
  const form = FORMS[kind];
  await page.goto(BASE + "/#/login", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.evaluate((tab) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === tab);
    if (b) b.click();
  }, form.tab);
  await page.waitForTimeout(800);
  const filled = await page.evaluate((fields) => {
    const set = (e, v) => {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      d.set.call(e, v);
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const visible = () => [...document.querySelectorAll("input")].filter((i) => i.offsetParent !== null);
    for (const [sel, val] of fields) {
      let el = null;
      if (sel === "email")         el = visible().find((i) => i.type === "email" || i.type === "text");
      else if (sel === "password") el = visible().find((i) => i.type === "password");
      else                          el = document.querySelector(sel);
      if (!el) return `field ${sel} not present`;
      set(el, val);
    }
    return null;
  }, form.fields);
  if (filled) return { ok: false, why: filled };
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].filter((x) => x.offsetParent !== null)
      .find((x) => x.textContent.trim().toLowerCase() === "sign in");
    if (b) b.click();
  });
  await page.waitForTimeout(5000);
  // The marketplace buyer signs in to OGGI, not to a shop, so a successful
  // login lands on "You buy from 6 wholesalers. Which one are you shopping
  // today?" -- which is the product working correctly, and which the first
  // version of this walker read as a failed login because the sign-in
  // screen's own heading is still in the DOM behind it.
  const picked = await page.evaluate((wantName) => {
    if (!/Which one are you shopping/i.test(document.body.innerText)) return null;
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(wantName));
    if (b) { b.click(); return wantName; }
    return "no store button matched";
  }, "Meridian");
  if (picked) await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    let local = null;
    try { local = JSON.parse(localStorage.getItem("oggi-v2-dev-session") || "null"); } catch {}
    const txt = document.body.innerText;
    return {
      local,
      stillOnLogin: /Sign in to continue/.test(txt),
      // whatever the screen says went wrong, rather than a generic failure
      // Only look for a message inside the status line the form writes, not
      // anywhere on the page: "Have an invite code but no account yet?" is
      // permanent footer text and was being reported as the failure reason.
      message: (document.querySelector("#staff-status, #sales-status, #mkt-status, #si-status")?.textContent || "").trim() || null,
    };
  });
  return {
    ok: !state.stillOnLogin,
    session: state.local,
    why: state.stillOnLogin ? (state.message || "still on the sign-in screen after submit") : "",
  };
}

const ROLE_SETUP = {
  public:     null,
  buyer:      (p) => signIn(p, "buyer"),
  sales:      (p) => signIn(p, "sales"),
  wholesaler: (p) => signIn(p, "wholesaler"),
  warehouse:  (p) => signIn(p, "warehouse"),
  finance:    (p) => signIn(p, "finance"),
  owner:      (p) => signIn(p, "owner"),
};

// WALK_ONLY=WS-03,WS-07 walks just those screens, for a tight loop on a fix.
const ONLY = (process.env.WALK_ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
for (const [role, list0] of Object.entries(ROUTES)) {
  const list = ONLY.length ? list0.filter((r) => ONLY.includes(r[0])) : list0;
  if (!list.length) continue;
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 160)); });
  // THE URL AND THE STATUS, NOT JUST "Bad Request".                19 Sep 2026
  // A 400 from PostgREST arrives with an empty body, so the console line is
  // the useless "Failed to load resource". The URL is the whole diagnosis:
  // three separate defects this week were an id list too long for a query
  // string, and you cannot see that without seeing the query string.
  page.on("response", (r) => {
    if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url().slice(0, 400)}`);
  });

  let setupNote = "no session needed";
  if (ROLE_SETUP[role]) {
    // RETRY ONCE. Sign-in goes over the network to Frankfurt and occasionally
    // just does not come back inside the wait. When that happened the walker
    // carried on and reported the whole role's screens as thin -- the
    // wholesaler dashboard came out at 603 characters instead of 1,871, which
    // looks exactly like a regression and is not one. A harness that reports a
    // false regression costs more than one that reports nothing.
    let r = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try { r = await ROLE_SETUP[role](page); } catch (e) { r = { ok: false, why: e.message.slice(0, 80) }; }
      if (r?.ok) break;
      if (attempt === 1) await page.waitForTimeout(2500);
    }
    setupNote = r?.ok ? "signed in" + (r.session?.wid ? " @ " + r.session.wid : "")
                      : "⚠ " + (r?.why || "unknown") + " (after 2 attempts)";
  }
  console.log(`\n── ${role} (${setupNote})`);

  for (const [id, route, name] of list) {
    errs.length = 0;
    const lastText = await page.evaluate(() => {
      const o = document.querySelector("#view-outlet") || document.querySelector("#app-root") || document.body;
      return o.innerText || "";
    }).catch(() => "");
    await page.goto(BASE + "/#" + route, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => window.scrollTo(0, 0));
    // SETTLE, don't sleep -- and settle on THIS screen, not the last one.
    //
    // Two ways this has already lied, both fixed here:
    //  1. A fixed 2.1s wait reported the inventory screen as 376 characters
    //     and blank. At 7s it renders nine sub-tabs and a full stock table.
    //  2. Polling for "text stops changing" returned instantly, because a hash
    //     navigation leaves the PREVIOUS screen in the outlet while the next
    //     one loads -- and the previous screen is perfectly stable. Favourites
    //     was reported with the cart's 80 cards and 111 images.
    // So: wait for the content to become something OTHER than what was there
    // before, and only then wait for it to stop growing.
    await page.evaluate(async (prev) => {
      const outlet = () => document.querySelector("#view-outlet") || document.querySelector("#app-root") || document.body;
      const read = () => (outlet().innerText || "");
      // A MINIMUM DWELL AND A LONGER STABILITY WINDOW.
      // Two stable reads is 600ms, and 600ms of nothing happening is a normal
      // pause while a screen waits on Frankfurt: the header is painted, the
      // rows are not, and the text length sits still. The walker took that for
      // "finished" and reported the owner's wholesaler list at 254 characters
      // when it really renders 3,849. Five reads is 1.5s of genuine quiet, and
      // nothing may settle before 1.2s have passed at all.
      let changed = false, last = -1, stable = 0;
      const startedAt = Date.now();
      for (let i = 0; i < 60; i++) {                  // ceiling: 60 x 300ms = 18s
        await new Promise((r) => setTimeout(r, 300));
        const t = read();
        if (!changed) { if (t !== prev) changed = true; else continue; }
        if (t.length === last && t.length > 0) {
          if (++stable >= 5 && Date.now() - startedAt > 1200) return;
        } else { stable = 0; last = t.length; }
      }
    }, lastText);
    await page.waitForTimeout(400);                   // let the last paint land
    const probe = await page.evaluate(() => {
      const root = document.querySelector("#app-root") || document.body;
      const txt = (root.innerText || "").replace(/\s+/g, " ").trim();
      const d = document.documentElement;
      return {
        chars: txt.length,
        digest: txt.slice(0, 150),
        overflow: d.scrollWidth - d.clientWidth,
        cards: document.querySelectorAll(".card, [class*='card']").length,
        tables: document.querySelectorAll("table").length,
        rows: document.querySelectorAll("tbody tr").length,
        imgs: document.querySelectorAll("img").length,
      };
    });
    const file = `${id}.png`;
    await page.screenshot({ path: join(OUT, file), fullPage: false });
    const bad = errs.filter((e) => !/favicon|manifest|sw\.js|ServiceWorker/i.test(e));
    report.screens.push({ id, role, route, name, file, ...probe, errors: [...new Set(bad)].slice(0, 4) });
    const flag = probe.chars < 120 ? " ⚠ EMPTY" : bad.length ? " ⚠ ERRORS" : "";
    console.log(`  ${id.padEnd(8)} ${route.padEnd(34)} ${String(probe.chars).padStart(5)} chars` +
                `  cards ${String(probe.cards).padStart(3)}  tbl ${probe.tables}/${String(probe.rows).padStart(3)}` +
                `  img ${String(probe.imgs).padStart(3)}${flag}`);
  }
  await ctx.close();
}
await browser.close(); srv.close();
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
const empty = report.screens.filter((s) => s.chars < 120);
const withErr = report.screens.filter((s) => s.errors.length);
console.log(`\n${report.screens.length}/${TOTAL} screens · ${empty.length} empty · ${withErr.length} with errors · ${OUT}`);
