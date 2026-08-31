// OGGI Wholesale v2 — real login (Batch 14)
// Replaces the Batch 0 "pick any role, no password" screen. Three real
// entry points, matching the two-tier auth model in js/lib/dev-auth.js:
//   Owner / Wholesaler -> email + password (real Supabase Auth), plus an
//     invite-code step for a first-time signup (owner/wholesaler accounts
//     are provisioned by invite only -- see dev-auth.js/migration 022).
//   Sales               -> username + password (v2_portal_accounts).
//   Buyer                -> wholesaler code + username + password, plus a
//     "request buyer access" form for someone who doesn't have an account
//     yet (goes to the wholesaler/owner's approval queue).
import { devAuth } from "../lib/dev-auth.js";
// ID-03, 30 Aug 2026 — the OGGI door. See renderBuyerPanel below for why it is
// offered FIRST and why the per-store door is kept rather than replaced.
import { marketplaceLogin, enterStore } from "../data/marketplace.js";
// 31 Aug 2026 — which front door was linked. Kept in its own import-free
// module so a Node gate can exercise it; see js/lib/login-doors.js.
import { doorFromHash } from "../lib/login-doors.js";

const TABS = [
  { key: "admin", label: "Owner / Wholesaler" },
  { key: "sales", label: "Sales team" },
  { key: "buyer", label: "Buyer" },
];

export function renderLogin(outlet, onLoggedIn) {
  let activeTab = "admin";
  // The door this person was linked to, if any. A bare "#/login" gives null
  // and leaves everything below exactly as it was. The initialiser above is
  // deliberately left in place rather than replaced -- overriding it keeps
  // this change additive, and keeps "admin" as the fallback in one place.
  const door = doorFromHash(typeof location !== "undefined" ? location.hash : "");
  if (door) activeTab = door.tab;
  // If bootstrap() already found a signed-in Supabase Auth user with no
  // profile yet (mid invite-redemption), jump straight to that step.
  const pending = devAuth.getSession();
  let adminStep = pending && pending.pendingAuthUser ? "invite" : "signin";
  // "oggi"    — ID-03, sign in to OGGI with a phone or email. THE DEFAULT.
  // "login"    — the original per-store door. Kept, not replaced (GP-02).
  // "request"  — ask a wholesaler for access.
  // "stores"   — signed in, and this person belongs to more than one shop.
  let buyerMode = "oggi";
  let mktStores = [];

  const wrap = document.createElement("div");
  wrap.style.cssText = "min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;";
  outlet.appendChild(wrap);

  function status(el, msg, type) {
    el.textContent = msg;
    el.style.color = type === "error" ? "var(--danger-600,#b3261e)" : type === "success" ? "var(--accent-600,#2f6b4f)" : "var(--text-tertiary)";
    el.style.fontSize = "12px";
    el.style.marginTop = "8px";
  }

  function render() {
    wrap.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "width:100%;max-width:460px;padding:32px;";

    const header = document.createElement("div");
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <span class="brand-mark" style="width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,var(--accent-500),var(--accent-700));color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;">O</span>
        <h2 style="margin:0;">OGGI Wholesale v2</h2>
      </div>
      <p style="color:var(--text-secondary);font-size:13px;margin-bottom:18px;">Sign in to continue. v1 stays live and untouched — this is a separate build.</p>
    `;
    card.appendChild(header);

    // Name the door, when one was linked. Someone sent the buyer link should
    // read the word "Buyer" before they read three tab labels.
    if (door && door.label) {
      const who = document.createElement("p");
      who.className = "login-door";
      who.textContent = door.label;
      who.style.cssText = "margin:-10px 0 16px;font-size:13px;font-weight:700;color:var(--text-primary);";
      card.appendChild(who);
    }

    const tabRow = document.createElement("div");
    tabRow.style.cssText = "display:flex;gap:6px;margin-bottom:18px;";
    TABS.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn btn-sm " + (activeTab === t.key ? "btn-primary" : "btn-secondary");
      b.textContent = t.label;
      b.addEventListener("click", () => { activeTab = t.key; render(); });
      tabRow.appendChild(b);
    });
    card.appendChild(tabRow);

    const panel = document.createElement("div");
    if (activeTab === "admin") renderAdminPanel(panel);
    else if (activeTab === "sales") renderSalesPanel(panel);
    else renderBuyerPanel(panel);
    card.appendChild(panel);

    wrap.appendChild(card);
  }

  function renderAdminPanel(panel) {
    if (adminStep === "invite") {
      panel.innerHTML = `
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">Your account is created — enter the invite code an owner (or, for the very first account, the bootstrap code Claude documented in the Batch 14 deploy record) gave you to activate it.</p>
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Invite code</label>
        <input class="input" id="invite-code" style="width:100%;margin-bottom:10px;" placeholder="paste the code here" />
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Your name (shown in the app)</label>
        <input class="input" id="invite-label" style="width:100%;margin-bottom:14px;" placeholder="e.g. Hadi Hamza" />
        <button class="btn btn-primary" id="redeem-btn" style="width:100%;">Activate account</button>
        <div id="admin-status"></div>
      `;
      const statusEl = panel.querySelector("#admin-status");
      panel.querySelector("#redeem-btn").addEventListener("click", async () => {
        const code = panel.querySelector("#invite-code").value.trim();
        const label = panel.querySelector("#invite-label").value.trim();
        if (!code) { status(statusEl, "Enter your invite code", "error"); return; }
        const btn = panel.querySelector("#redeem-btn"); btn.disabled = true;
        const result = await devAuth.redeemInvite(code, label);
        btn.disabled = false;
        if (!result.ok) { status(statusEl, result.error, "error"); return; }
        onLoggedIn(devAuth.getSession());
      });
      return;
    }

    if (adminStep === "signup") {
      panel.innerHTML = `
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">Create your account with a real email + password. You'll activate it with an invite code next.</p>
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Email</label>
        <input class="input" id="su-email" type="email" style="width:100%;margin-bottom:10px;" />
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Password (8+ characters)</label>
        <input class="input" id="su-pass" type="password" style="width:100%;margin-bottom:14px;" />
        <button class="btn btn-primary" id="signup-btn" style="width:100%;margin-bottom:8px;">Create account</button>
        <button class="btn btn-ghost btn-sm" id="back-to-signin" style="width:100%;">Back to sign in</button>
        <div id="admin-status"></div>
      `;
      const statusEl = panel.querySelector("#admin-status");
      panel.querySelector("#back-to-signin").addEventListener("click", () => { adminStep = "signin"; render(); });
      panel.querySelector("#signup-btn").addEventListener("click", async () => {
        const email = panel.querySelector("#su-email").value.trim();
        const password = panel.querySelector("#su-pass").value;
        if (!email || password.length < 8) { status(statusEl, "Enter a valid email and an 8+ character password", "error"); return; }
        const btn = panel.querySelector("#signup-btn"); btn.disabled = true;
        const result = await devAuth.signUp(email, password);
        btn.disabled = false;
        if (!result.ok) { status(statusEl, result.error, "error"); return; }
        if (result.needsEmailConfirmation) {
          status(statusEl, "Check your email to confirm your address, then come back and sign in.", "success");
          return;
        }
        adminStep = "invite"; render();
      });
      return;
    }

    // signin
    panel.innerHTML = `
      <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Email</label>
      <input class="input" id="si-email" type="email" style="width:100%;margin-bottom:10px;" />
      <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Password</label>
      <input class="input" id="si-pass" type="password" style="width:100%;margin-bottom:14px;" />
      <button class="btn btn-primary" id="signin-btn" style="width:100%;margin-bottom:8px;">Sign in</button>
      <button class="btn btn-ghost btn-sm" id="to-signup" style="width:100%;">Have an invite code but no account yet? Create one</button>
      <div id="admin-status"></div>
    `;
    const statusEl = panel.querySelector("#admin-status");
    panel.querySelector("#to-signup").addEventListener("click", () => { adminStep = "signup"; render(); });
    panel.querySelector("#signin-btn").addEventListener("click", async () => {
      const email = panel.querySelector("#si-email").value.trim();
      const password = panel.querySelector("#si-pass").value;
      if (!email || !password) { status(statusEl, "Enter your email and password", "error"); return; }
      const btn = panel.querySelector("#signin-btn"); btn.disabled = true;
      const result = await devAuth.signIn(email, password);
      btn.disabled = false;
      if (!result.ok) { status(statusEl, result.error, "error"); return; }
      if (result.needsInvite) { adminStep = "invite"; render(); return; }
      onLoggedIn(devAuth.getSession());
    });
  }

  function renderSalesPanel(panel) {
    panel.innerHTML = `
      <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Username</label>
      <input class="input" id="sales-user" style="width:100%;margin-bottom:10px;" />
      <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Password</label>
      <input class="input" id="sales-pass" type="password" style="width:100%;margin-bottom:14px;" />
      <button class="btn btn-primary" id="sales-btn" style="width:100%;">Sign in</button>
      <div id="sales-status"></div>
      <p style="font-size:11px;color:var(--text-tertiary);margin-top:12px;">Sales accounts are created by your wholesaler from Settings — ask them for a username and password.</p>
    `;
    const statusEl = panel.querySelector("#sales-status");
    panel.querySelector("#sales-btn").addEventListener("click", async () => {
      const user = panel.querySelector("#sales-user").value.trim();
      const pass = panel.querySelector("#sales-pass").value;
      if (!user || !pass) { status(statusEl, "Enter your username and password", "error"); return; }
      const btn = panel.querySelector("#sales-btn"); btn.disabled = true;
      const result = await devAuth.loginSales(user, pass);
      btn.disabled = false;
      if (!result.ok) { status(statusEl, result.error, "error"); return; }
      onLoggedIn(devAuth.getSession());
    });
  }

  function renderBuyerPanel(panel) {
    // ------------------------------------------------------------ ID-03 ----
    // SIGN IN TO OGGI. Offered first, and it asks for no wholesaler code —
    // which is the entire point. A buyer who has been invited to a marketplace
    // has no way to produce a code for a shop they have not met yet, and until
    // today the first field on this screen demanded one.
    //
    // The per-store door underneath is NOT a fallback that will be removed. It
    // is how everyone signs in today, it still works untouched, and GP-02 says
    // nobody gets forced to re-register.
    if (buyerMode === "oggi") {
      panel.innerHTML = `
        <p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">
          Sign in with the phone number your wholesaler has for you.
        </p>
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Phone number or email</label>
        <input class="input" id="mkt-id" inputmode="tel" autocomplete="username"
               style="width:100%;margin-bottom:10px;" placeholder="03 123 456" />
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Password</label>
        <input class="input" id="mkt-pass" type="password" autocomplete="current-password"
               style="width:100%;margin-bottom:14px;" />
        <button class="btn btn-primary" id="mkt-btn" style="width:100%;margin-bottom:8px;">Sign in</button>
        <button class="btn btn-ghost btn-sm" id="mkt-to-store" style="width:100%;">
          Sign in with a wholesaler code instead
        </button>
        <div id="buyer-status"></div>
      `;
      const statusEl = panel.querySelector("#buyer-status");
      panel.querySelector("#mkt-to-store").addEventListener("click", () => { buyerMode = "login"; render(); });

      const go = async () => {
        const id = panel.querySelector("#mkt-id").value.trim();
        const pass = panel.querySelector("#mkt-pass").value;
        if (!id || !pass) { status(statusEl, "Enter your phone number and password", "error"); return; }
        const btn = panel.querySelector("#mkt-btn"); btn.disabled = true; btn.textContent = "Signing in…";
        const r = await marketplaceLogin(id, pass);
        btn.disabled = false; btn.textContent = "Sign in";
        if (!r.ok) {
          // The server's single message, passed through unchanged. Elaborating
          // here would rebuild in the browser the enumeration oracle the
          // database was careful not to be.
          status(statusEl, r.error, "error");
          return;
        }
        const stores = r.stores || [];
        if (stores.length === 0) {
          // Signed in, and no wholesaler has let them in yet. A real state, and
          // a dead end if it is not said out loud.
          status(statusEl, "You are signed in, but no wholesaler has given you access yet. Ask one for access and they will let you in from their side.", "error");
          return;
        }
        if (stores.length === 1) {
          const e = await enterStore(stores[0].wid);
          if (!e.ok) { status(statusEl, e.error, "error"); return; }
          onLoggedIn(devAuth.getSession());
          return;
        }
        mktStores = stores; buyerMode = "stores"; render();
      };
      panel.querySelector("#mkt-btn").addEventListener("click", go);
      panel.querySelector("#mkt-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      return;
    }

    // ------------------------------------------------------------ ID-09 ----
    // More than one shop. Asked, never guessed: picking one for them and
    // silently opening it is how a buyer places an order with the wrong
    // wholesaler.
    if (buyerMode === "stores") {
      panel.innerHTML = `
        <p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">
          You buy from ${mktStores.length} wholesalers. Which one are you shopping today?
        </p>
        <div id="mkt-store-list" style="display:flex;flex-direction:column;gap:8px;"></div>
        <div id="buyer-status"></div>
      `;
      const statusEl = panel.querySelector("#buyer-status");
      const list = panel.querySelector("#mkt-store-list");
      mktStores.forEach((st) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-secondary";
        b.setAttribute("data-store-choice", st.wid);
        b.style.cssText = "width:100%;text-align:left;";
        b.textContent = st.wholesalerName;
        b.addEventListener("click", async () => {
          b.disabled = true;
          const e = await enterStore(st.wid);
          b.disabled = false;
          if (!e.ok) { status(statusEl, e.error, "error"); return; }
          onLoggedIn(devAuth.getSession());
        });
        list.appendChild(b);
      });
      return;
    }

    if (buyerMode === "request") {
      panel.innerHTML = `
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Wholesaler code</label>
        <input class="input" id="req-wid" style="width:100%;margin-bottom:10px;" placeholder="from your wholesaler" />
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Shop / business name</label>
        <input class="input" id="req-name" style="width:100%;margin-bottom:10px;" />
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Phone number</label>
        <input class="input" id="req-phone" type="tel" inputmode="tel" autocomplete="tel" style="width:100%;margin-bottom:4px;" placeholder="e.g. 03 456 789" />
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;">This is how they send you your login. Nothing is emailed.</div>
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Location</label>
        <input class="input" id="req-loc" style="width:100%;margin-bottom:10px;" />
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Typical order volume</label>
        <input class="input" id="req-vol" style="width:100%;margin-bottom:10px;" placeholder="e.g. 100 units/month" />
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">What do you sell?</label>
        <input class="input" id="req-sells" style="width:100%;margin-bottom:14px;" />
        <button class="btn btn-primary" id="req-btn" style="width:100%;margin-bottom:8px;">Request access</button>
        <button class="btn btn-ghost btn-sm" id="req-back" style="width:100%;">Back to sign in</button>
        <div id="buyer-status"></div>
      `;
      const statusEl = panel.querySelector("#buyer-status");
      panel.querySelector("#req-back").addEventListener("click", () => { buyerMode = "oggi"; render(); });
      panel.querySelector("#req-btn").addEventListener("click", async () => {
        const wid = panel.querySelector("#req-wid").value.trim();
        const name = panel.querySelector("#req-name").value.trim();
        const phone = panel.querySelector("#req-phone").value.trim();
        // Migration 108. Until 30 Aug this form collected NO way to reach the
        // applicant, so a wholesaler could approve them and then had nobody to
        // send the password to. The server refuses without a usable number; this
        // check exists so the refusal is instant and next to the field, not a
        // round trip later. The server's rule is the one that counts -- it also
        // rejects "12", which this cannot judge.
        if (!wid || !name) { status(statusEl, "Wholesaler code and shop name are required", "error"); return; }
        if (!phone) { status(statusEl, "A phone number is required — it is how they send you your login", "error"); return; }
        const btn = panel.querySelector("#req-btn"); btn.disabled = true;
        const result = await devAuth.requestBuyerAccess(
          wid, name,
          panel.querySelector("#req-loc").value.trim(),
          panel.querySelector("#req-vol").value.trim(),
          panel.querySelector("#req-sells").value.trim(),
          phone
        );
        btn.disabled = false;
        if (!result.ok) { status(statusEl, result.error, "error"); return; }
        status(statusEl, "Request sent — the wholesaler will reach out with your login once approved.", "success");
      });
      return;
    }

    panel.innerHTML = `
      <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Wholesaler code</label>
      <input class="input" id="buyer-wid" style="width:100%;margin-bottom:10px;" placeholder="from your wholesaler" />
      <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Username</label>
      <input class="input" id="buyer-user" style="width:100%;margin-bottom:10px;" />
      <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px;">Password</label>
      <input class="input" id="buyer-pass" type="password" style="width:100%;margin-bottom:14px;" />
      <button class="btn btn-primary" id="buyer-btn" style="width:100%;margin-bottom:8px;">Sign in</button>
      <button class="btn btn-ghost btn-sm" id="buyer-to-oggi" style="width:100%;margin-bottom:6px;">Sign in with your phone number instead</button>
      <button class="btn btn-ghost btn-sm" id="buyer-to-request" style="width:100%;">Don't have an account? Request access</button>
      <div id="buyer-status"></div>
    `;
    const statusEl = panel.querySelector("#buyer-status");
    panel.querySelector("#buyer-to-oggi").addEventListener("click", () => { buyerMode = "oggi"; render(); });
    panel.querySelector("#buyer-to-request").addEventListener("click", () => { buyerMode = "request"; render(); });
    panel.querySelector("#buyer-btn").addEventListener("click", async () => {
      const wid = panel.querySelector("#buyer-wid").value.trim();
      const user = panel.querySelector("#buyer-user").value.trim();
      const pass = panel.querySelector("#buyer-pass").value;
      if (!wid || !user || !pass) { status(statusEl, "Fill in all three fields", "error"); return; }
      const btn = panel.querySelector("#buyer-btn"); btn.disabled = true;
      const result = await devAuth.loginBuyer(wid, user, pass);
      btn.disabled = false;

      // A ban is not a typo. It gets its own panel rather than a one-line
      // red hint under the password box, because the person needs to
      // understand that retyping will not help and that OGGI cannot undo
      // it for them -- only their wholesaler can.
      if (result.banned) {
        panel.innerHTML = `
          <div style="text-align:center;padding:8px 4px 4px;">
            <div style="font-size:34px;line-height:1;margin-bottom:10px;">🚫</div>
            <div style="font-size:16px;font-weight:700;margin-bottom:8px;">Access withdrawn</div>
            <div style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin-bottom:16px;">
              ${result.error.replace(/</g, "&lt;")}
            </div>
            <button class="btn btn-ghost btn-sm" id="banned-back" style="width:100%;">Back to sign in</button>
          </div>
        `;
        panel.querySelector("#banned-back").addEventListener("click", () => { buyerMode = "login"; render(); });
        return;
      }

      if (!result.ok) { status(statusEl, result.error, "error"); return; }
      onLoggedIn(devAuth.getSession());
    });
  }

  render();
}
