// =============================================================================
// OGGI Wholesale v2 — SHARE LINKS, THE WHOLESALER'S SIDE  LINK-02/11, 8 Sep 2026
// =============================================================================
// Making a link, and looking at the ones you made. Hadi's description of what
// this screen is for, in his words:
//
//   "When they create a share link, they're gonna put in that person's phone
//    number. They're gonna put in their name, uh, but, basically, we're just
//    gonna look for their phone number to make sure that this is the same
//    person, and they're gonna set a discount for that link. And this is a one
//    time use link. So we have to make a link multiple times. and give them the
//    function, the ability to decide. Is this a one time link for one person,
//    or this is like an unlimited use link, or is this link but the approval is
//    needed? Or if it's auto approval with, like, a certain number of link
//    users?"
//
// ==== ITS OWN FILE, AND THAT IS THE POINT ==================================
//
// js/views/wholesaler.js is 5,400 lines and its own comment calls it "the last
// monolith in the repo". ranking-policy.js was split out for exactly this
// reason and exports registerRankingPolicyRoute; this follows it rather than
// adding a nineteenth screen to the monolith.
//
// ==== NO NAV ENTRY, ON PURPOSE =============================================
//
// The wholesaler sidebar is capped at NINE entries. That cap is Hadi's -- he
// said fifteen was two screens of scrolling before you reached Settings -- and
// a tenth entry for my own new screen is not a reason to raise it. Access
// requests made the same call on 28 Aug and are reached from Clients instead.
// This is reached from Clients too, which is where it belongs: a redeemed
// share link IS a new client.
//
// ==== THE BROWSER DECIDES NOTHING ==========================================
//
// Every rule about which links may exist lives in migration 129, and every one
// of them has a matching CHECK constraint on the table from 127. This screen
// SHOWS the fields a kind takes and HIDES the ones it does not -- which is an
// affordance, not a rule. If a caller sends a discount on an unlimited link
// anyway, the database refuses it with a sentence, and that sentence is what
// this screen displays, verbatim.
//
// Migration 121 is the record of the other arrangement: a disabled button is a
// UI state, not a rule. So nothing here is disabled to enforce anything.
//
// ==== THE REFUSALS ARE SHOWN, NOT TOASTED ==================================
//
// Two of them are ACTIONABLE and a notification that fades is the wrong
// container for an instruction:
//
//   D-2, and it names the shop: "Maison Rita is already your customer on that
//   number. Change their discount on their client record instead — a second
//   link would give them a second account." A toast here would leave the
//   wholesaler re-typing the same number.
//
//   D-5: "A discount can only go on a one-person link. Anyone can forward the
//   other kinds, and a rate you agreed with one shop would go with it."
//
// The same reasoning puts the finished LINK on the screen rather than in a
// toast: the link is the entire deliverable and it has to be copied somewhere
// else. AC-03's invite card settled that one on 29 Aug.
// =============================================================================

import { esc, pageHeader } from "../lib/utils.js";
import { emptyState } from "../components/empty-state.js";
import { toast } from "../components/toast.js";
import { confirmAction } from "../components/ask.js";
import { devAuth } from "../lib/dev-auth.js";
import { listCatalogs } from "../data/catalogs.js";
// One line per import on purpose: checks/check_share_link_screen.mjs loads this
// file with its imports stripped by `startsWith("import ")`, and a continuation
// line survives that filter and then fails to parse. join.js has the same
// property for the same reason.
import { listMyShareLinks, createShareLink, revokeShareLink, shareLinkUrl, shareLinkWhatsappHref } from "../data/share-links.js";

// The four kinds, and what each one actually does to the person who opens it.
// The sentences are the WHOLESALER's decision written out -- "unlimited" and
// "approval" are indistinguishable as words on a radio button, and the whole
// difference is who gets in without being asked about.
const KINDS = [
  {
    id: "one_time",
    label: "One person",
    blurb: "For one shop, on one number. They are in straight away — but only if they sign up with that number. Anyone else who opens it is sent to you to approve.",
    takesPhone: true, takesDiscount: true, takesCap: false,
  },
  {
    id: "unlimited",
    label: "Anyone with the link",
    blurb: "Everybody who opens it is in, with no limit and nothing for you to do. Post it, print it on a card, put it in a group.",
    takesPhone: false, takesDiscount: false, takesCap: false,
  },
  {
    id: "capped",
    label: "The first few",
    blurb: "The first shops to finish signing up are in automatically. After that the link still works — later arrivals are sent to you to approve instead of being turned away.",
    takesPhone: false, takesDiscount: false, takesCap: true,
  },
  {
    id: "approval",
    label: "You approve everyone",
    blurb: "Everybody who opens it gets an account and lands in your access requests. Nobody sees your prices until you say so.",
    takesPhone: false, takesDiscount: false, takesCap: false,
  },
];

const kindById = (id) => KINDS.find((k) => k.id === id) || KINDS[0];

// The state comes from SQL and is rendered, never recomputed. Migration 129
// computes it once for exactly this reason: four `if`s in the browser is four
// places for the rules to drift from the database's.
const STATE_LABEL = {
  active: "Live", used: "Used", full: "Full",
  expired: "Expired", revoked: "Withdrawn",
};
const STATE_BADGE = {
  active: "badge-success", used: "badge-info", full: "badge-info",
  expired: "badge-neutral", revoked: "badge-neutral",
};

/** Copy, with the fallback the invite card already uses. A clipboard API that
 *  is not available is not a reason to lose the link. */
async function copyText(text, host, say) {
  try { await navigator.clipboard.writeText(text); say("Link copied."); return; }
  catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("aria-hidden", "true"); ta.tabIndex = -1;
  ta.style.cssText = "position:absolute;left:-9999px;opacity:0;height:1px;width:1px;";
  host.appendChild(ta); ta.select();
  try { document.execCommand("copy"); say("Link copied."); }
  catch { say(text); }
  ta.remove();
}

export async function shareLinksView(outlet) {
  const session = devAuth.getSession();
  const wholesalerName = session?.wholesalerName || "";

  outlet.appendChild(pageHeader(
    "Share links",
    "One link, sent on WhatsApp, and the shop that opens it is signed up to the marketplace and into your store."
  ));

  // Nothing is emailed and nothing ever has been -- migration 024 says so in
  // its own comment rather than pretending. Saying it here means the wholesaler
  // never waits for a delivery that is not coming.
  const note = document.createElement("div");
  note.className = "card no-print";
  note.style.cssText = "padding:12px 14px;margin-bottom:14px;font-size:13px;color:var(--text-secondary);";
  note.textContent = "You send these yourself — nothing is emailed. Whoever opens one ends up with an account on the marketplace either way; the link decides whether they walk straight into your store or land in your access requests.";
  outlet.appendChild(note);

  const form = document.createElement("div");
  form.className = "card no-print";
  form.style.cssText = "padding:16px;margin-bottom:16px;";
  outlet.appendChild(form);

  const listHost = document.createElement("div");
  outlet.appendChild(listHost);

  // The shelf list is optional and its absence must not stop a link being
  // made, so a failure here leaves the picker empty rather than throwing.
  let catalogs = [];
  try { catalogs = (await listCatalogs(session.wid)) || []; } catch { catalogs = []; }

  let kind = "one_time";

  function paintForm() {
    const k = kindById(kind);
    form.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <strong style="font-size:14px;">Make a link</strong>
        <span style="font-size:11.5px;color:var(--text-tertiary);">Works for 30 days unless you say otherwise.</span>
      </div>

      <div role="radiogroup" aria-label="Link type" data-kinds
           style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin-bottom:12px;">
        ${KINDS.map((opt) => `
          <button type="button" role="radio" data-kind="${esc(opt.id)}"
                  aria-checked="${opt.id === kind ? "true" : "false"}"
                  style="text-align:left;padding:10px 12px;border-radius:8px;cursor:pointer;font:inherit;color:inherit;
                         border:1px solid ${opt.id === kind ? "var(--accent-500)" : "var(--border-subtle)"};
                         background:${opt.id === kind ? "var(--accent-50)" : "transparent"};">
            <span style="display:block;font-weight:650;font-size:13px;">${esc(opt.label)}</span>
            <span style="display:block;font-size:11.5px;color:var(--text-secondary);margin-top:3px;line-height:1.35;">${esc(opt.blurb)}</span>
          </button>`).join("")}
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        ${k.takesPhone ? `
          <label style="flex:1 1 160px;min-width:0;">
            <span style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">Their phone <strong>(required)</strong></span>
            <input class="input" data-f="phone" type="tel" inputmode="tel" placeholder="03 456 789">
          </label>
          <label style="flex:1 1 160px;min-width:0;">
            <span style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">Their name (optional)</span>
            <input class="input" data-f="name" type="text" placeholder="Maison Rita">
          </label>` : ""}
        ${k.takesCap ? `
          <label style="flex:0 1 150px;min-width:0;">
            <span style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">How many get in <strong>(required)</strong></span>
            <input class="input" data-f="max" type="number" min="1" step="1" placeholder="5">
          </label>` : ""}
        ${k.takesDiscount ? `
          <label style="flex:0 1 130px;min-width:0;">
            <span style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">Discount % (optional)</span>
            <input class="input" data-f="discount" type="number" step="0.5" placeholder="10">
          </label>` : ""}
        <label style="flex:0 1 110px;min-width:0;">
          <span style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">Days it lasts</span>
          <input class="input" data-f="days" type="number" min="1" max="180" step="1" value="30">
        </label>
        <button type="button" class="btn btn-primary btn-sm" data-a="make">Make the link</button>
      </div>

      <details style="margin-top:10px;">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:600;padding:4px 0;">Add a catalogue or a note</summary>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px;">
          <label style="flex:1 1 200px;min-width:0;">
            <span style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">Land them on a catalogue</span>
            <select class="input" data-f="catalog">
              <option value="">Your whole store</option>
              ${catalogs.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}
            </select>
          </label>
          <label style="flex:1 1 220px;min-width:0;">
            <span style="display:block;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">A note for yourself</span>
            <input class="input" data-f="note" type="text" placeholder="Met at the Tripoli fair">
          </label>
        </div>
        ${k.takesDiscount ? "" : `
          <p style="font-size:11.5px;color:var(--text-tertiary);margin:8px 0 0;">
            A discount only goes on a one-person link. Anyone can forward the other kinds,
            and a rate you agreed with one shop would go with it.</p>`}
      </details>

      <div data-slot="out" style="margin-top:10px;"></div>
    `;

    form.querySelectorAll("[data-kind]").forEach((b) => {
      b.addEventListener("click", () => { kind = b.getAttribute("data-kind"); paintForm(); });
    });

    form.querySelector('[data-a="make"]').addEventListener("click", onMake);
  }

  async function onMake() {
    const btn = form.querySelector('[data-a="make"]');
    const out = form.querySelector('[data-slot="out"]');
    const val = (f) => form.querySelector(`[data-f="${f}"]`)?.value?.trim() ?? "";
    const k = kindById(kind);

    btn.disabled = true; btn.textContent = "Making…";
    const res = await createShareLink({
      kind,
      inviteeName: k.takesPhone ? (val("name") || null) : null,
      inviteePhone: k.takesPhone ? (val("phone") || null) : null,
      discountPct: k.takesDiscount && val("discount") !== "" ? val("discount") : null,
      maxUses: k.takesCap && val("max") !== "" ? val("max") : null,
      catalogId: val("catalog") || null,
      days: Number(val("days")) || 30,
      note: val("note") || null,
    });
    btn.disabled = false; btn.textContent = "Make the link";

    if (!res.ok) {
      // ⭐ SHOWN, NOT TOASTED. Two of these refusals tell the wholesaler what
      // to do instead -- D-2 names the shop and sends them to that shop's
      // client record; D-5 explains why a forwarded discount is a problem --
      // and an instruction that fades after four seconds is an instruction
      // nobody follows.
      out.innerHTML = `
        <div class="card" style="padding:12px 14px;border-left:3px solid var(--danger,#b42318);
             background:var(--danger-bg,rgba(180,35,24,.06));font-size:13px;">
          ${esc(res.error || "Could not make the link")}
          ${/already your customer/i.test(res.error || "")
            ? ` <a href="#/wholesaler/clients" style="font-weight:600;">Open Clients</a>` : ""}
        </div>`;
      return;
    }

    const url = shareLinkUrl(res.token);
    out.innerHTML = `
      <div class="card" style="padding:12px 14px;border:1px solid var(--accent-500);background:var(--accent-50);">
        <strong style="font-size:13.5px;">Link ready.</strong>
        <div style="font-size:12px;color:var(--text-secondary);margin:4px 0 8px;">
          Send it on WhatsApp, or copy it. It stops working ${esc(new Date(res.expiresAt).toLocaleDateString())}.
        </div>
        <code data-url style="display:block;font-size:12px;word-break:break-all;margin-bottom:8px;">${esc(url)}</code>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <a class="btn btn-primary btn-sm" target="_blank" rel="noopener"
             href="${esc(shareLinkWhatsappHref(res.token, { wholesalerName, inviteeName: form.querySelector('[data-f="name"]')?.value?.trim() || null }))}">Send on WhatsApp</a>
          <button type="button" class="btn btn-ghost btn-sm" data-a="copy">Copy link</button>
        </div>
        <div data-slot="say" style="font-size:12px;color:var(--text-secondary);margin-top:6px;"></div>
      </div>`;
    out.querySelector('[data-a="copy"]').addEventListener("click", () => {
      copyText(url, out, (m) => { out.querySelector('[data-slot="say"]').textContent = m; });
    });

    // ⚠️ The list below is repainted, the RESULT ABOVE IS NOT. Repainting the
    // form would destroy the link that was just made to refresh a list sitting
    // underneath it -- the wrong way round, and the same trade AC-03's bulk
    // invite card refused on 29 Aug. The link is why the button was pressed.
    await paintList();
  }

  async function paintList() {
    const rows = await listMyShareLinks();
    listHost.innerHTML = "";

    if (!rows.length) {
      listHost.appendChild(emptyState({
        icon: "🔗",
        title: "No links yet",
        body: "Make one above and send it to a shop. Whoever opens it ends up with an account, and you decide whether that means walking into your store or waiting for you.",
      }));
      return;
    }

    const live = rows.filter((r) => r.state === "active").length;
    const head = document.createElement("div");
    head.style.cssText = "font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:var(--text-tertiary);margin:4px 0 6px;";
    head.textContent = live ? `${live} live · ${rows.length} in total` : `${rows.length} link${rows.length === 1 ? "" : "s"}`;
    listHost.appendChild(head);

    const list = document.createElement("div");
    list.className = "card";
    list.style.padding = "6px 12px";

    rows.forEach((r) => {
      const k = kindById(r.kind);
      const row = document.createElement("div");
      row.setAttribute("data-link-state", r.state);
      row.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;"
        + "border-bottom:1px solid var(--border-subtle);font-size:13px;"
        + (r.state === "active" ? "" : "opacity:.7;");

      // ⭐ "3 of 5 used" is a lie about a capped link forty people opened, so
      // the people who were sent to the approval queue are counted separately
      // and out loud. uses_count counts GRANTS -- migration 128 note (d), and
      // the reason v2_my_share_links carries requests_count at all.
      const used = r.maxUses ? `${r.usesCount} of ${r.maxUses} in` : `${r.usesCount} in`;
      const asked = r.requestsCount
        ? ` · <a href="#/wholesaler/requests" style="font-weight:600;">${r.requestsCount} waiting on you</a>`
        : "";

      const who = r.inviteeName || r.inviteePhone
        ? `${esc(r.inviteeName || "")}${r.inviteeName && r.inviteePhone ? " · " : ""}${esc(r.inviteePhone || "")}`
        : esc(k.label);

      row.innerHTML = `
        <span style="flex:1 1 180px;min-width:0;">
          <span style="display:block;font-weight:650;">${who}</span>
          <span style="display:block;font-size:11.5px;color:var(--text-secondary);">
            ${esc(k.label)} · ${used}${asked}${r.discountPct ? ` · ${esc(String(r.discountPct))}% off` : ""}${r.catalogName ? ` · ${esc(r.catalogName)}` : ""}
          </span>
          ${r.note ? `<span style="display:block;font-size:11.5px;color:var(--text-tertiary);">${esc(r.note)}</span>` : ""}
        </span>
        <span class="badge ${STATE_BADGE[r.state] || "badge-neutral"}">${esc(STATE_LABEL[r.state] || r.state)}</span>
        <span style="font-size:11px;color:var(--text-tertiary);">
          ${r.state === "revoked" ? "withdrawn" : r.state === "expired" ? "ended" : "ends"}
          ${esc(new Date(r.revokedAt || r.expiresAt).toLocaleDateString())}
        </span>
      `;

      // A dead link gets no Send button. That is not a rule being enforced in
      // the browser -- the database is what makes it dead, and the peek screen
      // says so in its own words to anyone who still has the URL. It is simply
      // that offering to WhatsApp a link that no longer opens is offering to
      // waste somebody's afternoon.
      if (r.state === "active") {
        const wa = document.createElement("a");
        wa.className = "btn btn-secondary btn-sm";
        wa.href = shareLinkWhatsappHref(r.token, { wholesalerName, inviteeName: r.inviteeName });
        wa.target = "_blank"; wa.rel = "noopener";
        wa.textContent = "WhatsApp";
        row.appendChild(wa);

        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "btn btn-ghost btn-sm";
        copy.textContent = "Copy link";
        copy.addEventListener("click", () => {
          copyText(shareLinkUrl(r.token), row, (m) => toast(m, { type: "default" }));
        });
        row.appendChild(copy);
      }

      if (!r.revokedAt) {
        const off = document.createElement("button");
        off.type = "button";
        off.className = "btn btn-ghost btn-sm";
        off.textContent = "Withdraw";
        off.addEventListener("click", async () => {
          const yes = await confirmAction({
            title: "Withdraw this link?",
            body: "It stops working immediately. Anyone who already came through it keeps their account and their access — withdrawing a link does not take anything back.",
            confirmLabel: "Withdraw it",
            danger: true,
          });
          if (!yes) return;
          const res = await revokeShareLink(r.id);
          if (!res.ok) { toast(res.error || "Could not withdraw that link", { type: "danger" }); return; }
          toast("Link withdrawn", { type: "default" });
          await paintList();
        });
        row.appendChild(off);
      }

      list.appendChild(row);
    });

    listHost.appendChild(list);
  }

  paintForm();
  await paintList();
}

export function registerShareLinkAdminRoutes(router) {
  router.register("/wholesaler/links", (outlet) => shareLinksView(outlet));
}
