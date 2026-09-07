// =============================================================================
// OGGI Wholesale v2 — JOINING THROUGH A LINK             LINK-05/10, 8 Sep 2026
// =============================================================================
// The screen a stranger lands on. They have no account — that is the entire
// point — so it works with no session, which is why it is registered among the
// public routes rather than anywhere behind the login gate.
//
// ==== THE ONE SENTENCE THIS SCREEN IS ARRANGED AROUND =====================
//
//   NOBODY WHO OPENS A REAL LINK IS EVER TURNED AWAY FROM OGGI.
//
// Hadi: "either way, they get access and they are logged in. They are signed
// up to the marketplace itself." So there is no state of this screen where a
// person holding a real link is shown a wall. A used-up link, a full cap and
// an approval-needed link all show THE SAME FORM; only the sentence above it
// changes, and only the ending differs.
//
// ==== WHAT THIS SCREEN DOES NOT SAY, AND WHY ==============================
//
// It never greets them by name. The database will not tell it who the link was
// sent to (migration 129 deliberately does not return invitee_name), and this
// file must not invent a substitute. A one-person link is sent to one number
// on WhatsApp, and WhatsApp messages get forwarded: "Hi Rita" on a forwarded
// link publishes, to whoever it reaches, a fact the wholesaler told exactly
// one person.
//
// It does name the WHOLESALER, first and largest, because a link arriving on
// WhatsApp with no context is a link nobody taps — the 28 Aug complaint
// research, and the same reason the invitation screen leads with it.
//
// ==== WHY A DEAD LINK HERE READS DIFFERENTLY FROM A DEAD INVITATION =======
//
// js/views/public-order.js tells withdrawn, used and expired invitations apart
// on purpose, because an invitation is held by someone the wholesaler chose to
// contact. A SHARE link is different: it can be forwarded, and a stranger
// probing tokens must not learn which ones were ever real. So not-found,
// withdrawn and expired are one answer here — and it is the server's answer,
// rendered verbatim, so this file cannot drift away from what redemption says.
//
// ==== THE FORM IS SIX FIELDS AND THAT IS THE CEILING ======================
//
// Cartona's number, from the 28 Aug research: before they moved verification
// after login, only 14.24% of installs became registrations and 99% of the
// rest left. Every field is a place to leave. The six are the ones
// v2_create_client has refused to do without since migration 060 — shop name,
// their name, phone, username, password — plus what they sell, which is the
// questionnaire (LINK-10) and the only optional one on the screen.
// =============================================================================

import { peekShareLink, redeemShareLink } from "../data/share-links.js";
import { esc } from "../lib/utils.js";

/** The three endings. Each says what happened AND what comes next; "error" is
 *  never one of them, because it is the one thing a person cannot act on. */
const ENDINGS = {
  joined: (w) => ({
    icon: "🎉",
    title: "You're in",
    body: `${w || "The store"} is now in your OGGI account, and you are signed in. Open it and start ordering.`,
    cta: "Open the store",
  }),
  requested: (w) => ({
    icon: "📬",
    title: "You're signed up to OGGI",
    body: `${w || "The store"} has been asked to give you access. You are signed in already — you will see their store appear as soon as they say yes.`,
    cta: "Go to OGGI",
  }),
  already: (w) => ({
    icon: "👋",
    title: "You already shop here",
    body: `You are signed in, and ${w || "this store"} is already in your account.`,
    cta: "Open the store",
  }),
};

export async function joinView(outlet, params) {
  const token = params?.token;
  outlet.className = "po-page";
  outlet.innerHTML = `<div class="po-loading">Opening your invitation…</div>`;

  const link = await peekShareLink(token);

  // A NETWORK FAILURE IS NOT A DEAD LINK, and the two must not share a screen.
  // Telling somebody with a perfectly good link to go and ask for a new one is
  // worse than telling them nothing.
  if (link.status === "error") {
    outlet.innerHTML = `
      <div class="po-empty">
        <div class="po-empty-icon">📡</div>
        <h1>We couldn't reach OGGI</h1>
        <p>${esc(link.msg)}</p>
        <button class="btn btn-primary" data-a="retry" style="margin-top:14px;">Try again</button>
      </div>`;
    outlet.querySelector('[data-a="retry"]').addEventListener("click", () => joinView(outlet, params));
    return;
  }

  // Not found, withdrawn and expired: one answer, and it is the SERVER'S
  // answer rendered verbatim rather than a copy of it kept here.
  if (link.status !== "ok") {
    outlet.innerHTML = `
      <div class="po-empty">
        <div class="po-empty-icon">🔗</div>
        <h1>This link isn't active</h1>
        <p>${esc(link.msg)}</p>
      </div>`;
    return;
  }

  const who = link.wholesalerName || "A wholesaler";

  outlet.innerHTML = `
    <article class="po-sheet inv-card">
      <header class="po-head">
        <div>
          <div class="po-eyebrow">Invitation</div>
          <h1>${esc(who)}</h1>
          <p class="po-sub">${esc(link.msg)}</p>
        </div>
      </header>
      <form class="inv-form" novalidate>
        <label class="inv-field">
          <span>Your shop's name</span>
          <input class="input" name="shop" type="text" autocomplete="organization" required>
        </label>
        <label class="inv-field">
          <span>Your name</span>
          <input class="input" name="person" type="text" autocomplete="name">
        </label>
        <label class="inv-field">
          <span>Your phone number</span>
          <input class="input" name="phone" type="tel" autocomplete="tel"
                 inputmode="tel" placeholder="03 456 789" required>
          <small>${link.hint === "phone_must_match"
            ? "Use the number they sent this to and you are straight in."
            : "This is how they reach you about your orders."}</small>
        </label>
        <label class="inv-field">
          <span>What do you sell?</span>
          <input class="input" name="sells" type="text" placeholder="Womenswear, kidswear…">
          <small>Optional. It helps them show you the right things.</small>
        </label>
        <label class="inv-field">
          <span>Choose a username</span>
          <input class="input" name="username" type="text" autocomplete="username"
                 autocapitalize="none" spellcheck="false" required>
        </label>
        <label class="inv-field">
          <span>Choose a password</span>
          <input class="input" name="password" type="password" autocomplete="new-password" required>
          <small>At least 6 characters. This signs you in to OGGI, not only to this store.</small>
        </label>
        <div class="inv-msg" data-slot="msg" role="alert"></div>
        <button type="submit" class="btn btn-primary inv-go">Sign up</button>
        <p class="po-terms">Nothing is paid here. ${esc(who)} invoices you the way they always do.</p>
      </form>
    </article>
  `;

  const form = outlet.querySelector("form");
  const msg = outlet.querySelector('[data-slot="msg"]');
  const go = outlet.querySelector(".inv-go");

  // Looked up explicitly rather than through form.shop / form.username. Named
  // form access is a real browser feature and a footgun -- a field named
  // "submit" shadows the form's own method, silently -- and jsdom does not
  // implement it, so code that relies on it is code no gate can reach.
  const f = (n) => form.querySelector(`[name="${n}"]`);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const shop = f("shop").value.trim();
    const person = f("person").value.trim();
    const phone = f("phone").value.trim();
    const sells = f("sells").value.trim();
    const username = f("username").value.trim();
    const password = f("password").value;

    // Checked here so the answer is instant, and checked again in the database
    // so a stray call cannot make a half-record. The message names the field.
    if (!shop) { msg.textContent = "Please give your shop's name."; f("shop").focus(); return; }
    if (!phone) { msg.textContent = "Please give a phone number we can reach you on."; f("phone").focus(); return; }
    if (username.length < 3) { msg.textContent = "Your username needs at least 3 characters."; f("username").focus(); return; }
    if (password.length < 6) { msg.textContent = "Your password needs at least 6 characters."; f("password").focus(); return; }

    go.disabled = true;
    const before = go.textContent;
    go.textContent = "Signing you up…";
    msg.textContent = "";

    const res = await redeemShareLink(token, {
      phone, name: person, shopName: shop, username, password,
      // LINK-10 will read this. Sent now so the answer is not thrown away
      // between the person typing it and the questionnaire shipping; migration
      // 128 accepts and ignores it, and says so.
      answers: sells ? { sells } : null,
    });

    if (!res.ok) {
      msg.textContent = res.error;
      go.disabled = false;
      go.textContent = before;
      return;
    }

    const end = (ENDINGS[res.outcome] || ENDINGS.requested)(res.wholesalerName || who);
    outlet.innerHTML = `
      <div class="po-empty">
        <div class="po-empty-icon">${end.icon}</div>
        <h1>${esc(end.title)}</h1>
        <p>${esc(end.body)}</p>
        <p style="margin-top:6px;font-size:13px;color:var(--text-secondary);">${esc(res.msg)}</p>
        <a class="btn btn-primary" href="#/" style="margin-top:14px;display:inline-flex;">${esc(end.cta)}</a>
      </div>`;
  });
}
