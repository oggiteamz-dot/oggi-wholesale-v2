// =============================================================================
// OGGI Wholesale v2 — BROWSER HARNESS                            19 Sep 2026
// =============================================================================
//
// The working-tree server and the six real sign-ins, in ONE place.
//
// They were inline in checks/tools/walk.mjs. The moment a second harness
// needed to sign a buyer in -- check_ordered_lines_show_a_picture.mjs -- the
// choice was a second copy or one module, and this repo's README answers that
// already: "Duplicated helpers do not stay identical. They wait." Two copies
// of a login means the day someone changes a field id, one harness keeps
// passing and reports on a sign-in screen it mistook for the product.
//
// WALK_BASE points any caller at the deployed site instead of this tree.
// =============================================================================

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PW = "OggiDemo-2026";
export const WID = "demo-meridian";

const MIME = { ".html":"text/html",".css":"text/css",".js":"text/javascript",".json":"application/json",
  ".woff2":"font/woff2",".png":"image/png",".svg":"image/svg+xml",".ico":"image/x-icon",".webmanifest":"application/manifest+json" };

/** Serves this working tree on an ephemeral port and hands back { BASE, close }.
 *  With WALK_BASE set the server still starts (so close() is always safe to
 *  call) but BASE points at the deployed site. */
export async function serveTree() {
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
  return { BASE, close: () => srv.close() };
}

/** Sign in through the app's own login screen, the way a person does.
 *  Field ids are the REAL ones, read off the running app by
 *  checks/tools/probe-login.mjs -- the first version of this guessed the
 *  order of whatever inputs happened to be visible and silently logged the
 *  buyer into nothing. */
export const FORMS = {
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

export async function signIn(page, kind, BASE) {
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

