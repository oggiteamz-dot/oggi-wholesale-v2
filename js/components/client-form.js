// OGGI Wholesale v2 — "Add a client" (migration 060)
//
// Hadi, 20 Aug 2026: "I want them to be able to create this account by the
// bare minimum, meaning the required stuff are on the top. And then the
// secondary important stuff can be created another day. That's not a
// problem. Just to make it easier for them to actually do this."
//
// SIX REQUIRED FIELDS, AND NOT A SEVENTH
// ---------------------------------------------------------------------
// Company name · Owner name · Owner phone · What they sell · Username ·
// Password. Everything else lives behind "Add more details" and can be
// filled in any day after.
//
// This is not a guess about attention spans. Across the 19 B2B platforms
// researched for this feature, the ones that ask everything up front are
// the ones buyers abandon: JOOR's real retailer form asks for no tax ID
// and no licence, Shopify B2B's only mandatory fields are company name
// and email, and Faire defers verification until AFTER a first order
// rather than blocking signup on it. The pattern that works is a short
// create plus event-triggered asks later.
//
// Equally: form LENGTH is not the lever people think it is. Zuko, which
// instruments real live forms rather than surveying opinions, found "the
// length of a form makes almost no difference to the rate at which people
// complete it". What they did measure was ~10% from preserving what the
// user typed when they navigate. So this form keeps its values on a
// failed submit instead of clearing them, and that matters more than the
// field count does.
//
// THE PASSWORD IS SHOWN ONCE
// ---------------------------------------------------------------------
// It is bcrypt-hashed server-side inside v2_create_client and returned in
// that one response. There is no column holding it readable and no
// function that can hand it back -- only a reset. So the reveal panel is
// the single moment it exists in plain text, which is why it carries Copy
// and Send-on-WhatsApp buttons and refuses to close quietly.
//
// The wholesaler WILL send it over WhatsApp. That is how this market
// works and pretending otherwise builds the wrong product. The mitigation
// is `must_change_password`: the buyer has to replace it on first
// sign-in, so the copy sitting in a WhatsApp thread is dead on arrival.
import { esc } from "../lib/utils.js";
import { openModal, closeModal } from "../lib/modal-stack.js";
import { renderTagInput } from "./tag-input.js";
import { createClient } from "../data/clients.js";

// Sensible starting suggestions for "what do they sell". Not a closed
// list -- the tag input accepts anything typed. A closed list would be us
// deciding what trades exist, which is exactly the mistake the wholesaler
// -owned field toggle (v2_wholesalers.client_fields) exists to avoid.
const SELLS_SUGGESTIONS = [
  "Womenswear", "Menswear", "Kidswear", "Babywear", "Denim", "Footwear",
  "Accessories", "Bags", "Lingerie", "Sportswear", "Abaya", "Homewear",
];

const BUSINESS_TYPES = [
  ["", "—"],
  ["shop", "Shop"],
  ["boutique", "Boutique"],
  ["market_stall", "Market stall"],
  ["online", "Online only"],
  ["distributor", "Distributor"],
  ["other", "Other"],
];

function field(label, id, { type = "text", required = false, placeholder = "", width = "100%" } = {}) {
  return `
    <div style="flex:1 1 ${width === "100%" ? "100%" : width};min-width:0;">
      <label for="${id}" style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">
        ${esc(label)}${required ? ` <span style="color:var(--danger,#b42318);">*</span>` : ""}
      </label>
      <input class="input" id="${id}" type="${type}" placeholder="${esc(placeholder)}" style="width:100%;" />
    </div>`;
}

/** The "Add a client" card. `onCreated` is called after a successful save
 *  so the list behind it can refresh. */
export function renderClientForm({ onCreated = () => {} } = {}) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:18px;margin-bottom:16px;";

  card.innerHTML = `
    <div style="font-weight:700;font-size:15px;margin-bottom:2px;">Add a client</div>
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;">
      Six things to get them trading. Everything else can wait — you can fill it in any time.
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
      ${field("Company name", "cf-shop", { required: true, placeholder: "Boutique Farah", width: "220px" })}
      ${field("Owner name", "cf-owner", { required: true, placeholder: "Farah Chami", width: "200px" })}
      ${field("Owner phone", "cf-phone", { required: true, placeholder: "03 456 789", width: "170px" })}
    </div>

    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">
        What do they sell? <span style="color:var(--danger,#b42318);">*</span>
      </label>
      <div id="cf-sells-host"></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;" id="cf-sells-suggest"></div>
    </div>

    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:4px;">
      ${field("Username", "cf-user", { required: true, placeholder: "farah", width: "170px" })}
      <div style="flex:1 1 240px;min-width:0;">
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">
          Password <span style="color:var(--danger,#b42318);">*</span>
        </label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input class="input" id="cf-pass" type="text" placeholder="Leave empty to generate one" style="flex:1;min-width:0;" />
          <button type="button" class="btn btn-ghost btn-sm" id="cf-gen" title="Generate a random password">Generate</button>
        </div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">
          Shown once, then never again — only reset. They must change it on first sign-in.
        </div>
      </div>
    </div>

    <button type="button" id="cf-more-toggle" class="btn btn-ghost btn-sm" style="margin:10px 0;">
      ▸ Add more details <span style="color:var(--text-tertiary);font-weight:400;">(optional)</span>
    </button>

    <div id="cf-more" hidden style="border-top:1px solid var(--border-subtle);padding-top:14px;">
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        ${field("City", "cf-city", { width: "150px" })}
        ${field("Area / district", "cf-area", { width: "150px" })}
        ${field("Address", "cf-address", { width: "240px" })}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        ${field("Second phone", "cf-phone2", { width: "150px" })}
        ${field("Email", "cf-email", { type: "email", width: "200px" })}
        ${field("Instagram", "cf-instagram", { placeholder: "@handle", width: "160px" })}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        <div style="flex:1 1 150px;min-width:0;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">Business type</label>
          <select class="input" id="cf-btype" style="width:100%;">
            ${BUSINESS_TYPES.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}
          </select>
        </div>
        ${field("Branches", "cf-branches", { type: "number", width: "110px" })}
        ${field("Years in business", "cf-years", { type: "number", width: "140px" })}
        <div style="flex:1 1 130px;min-width:0;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">Language</label>
          <select class="input" id="cf-lang" style="width:100%;">
            <option value="">—</option><option value="AR">Arabic</option>
            <option value="EN">English</option><option value="FR">French</option>
          </select>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:4px;">
        ${field("Discount %", "cf-discount", { type: "number", placeholder: "0", width: "110px" })}
        <div style="flex:1 1 130px;min-width:0;">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">Customer tier</label>
          <select class="input" id="cf-tier" style="width:100%;">
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">Tier ${n}</option>`).join("")}
          </select>
        </div>
        ${field("Note", "cf-note", { width: "240px" })}
      </div>
      <div style="font-size:11px;color:var(--text-tertiary);margin-top:10px;">
        Nothing here is required. A client with only the six fields above works exactly the same.
      </div>
    </div>

    <div id="cf-error" style="color:var(--danger,#b42318);font-size:13px;min-height:18px;margin:10px 0 6px;"></div>
    <button type="button" class="btn btn-primary" id="cf-save">Add client</button>
  `;

  const $ = (id) => card.querySelector("#" + id);

  // ---- what they sell -------------------------------------------------
  const sells = renderTagInput({ placeholder: "Type a category and press Enter" });
  $("cf-sells-host").appendChild(sells.el);

  const suggestRow = $("cf-sells-suggest");
  SELLS_SUGGESTIONS.forEach((s) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "btn btn-ghost btn-sm";
    chip.style.cssText = "padding:2px 10px;font-size:12px;border-radius:999px;";
    chip.textContent = "+ " + s;
    chip.addEventListener("click", () => {
      const cur = sells.getValues();
      if (!cur.some((v) => v.toLowerCase() === s.toLowerCase())) sells.setValues(cur.concat([s]));
    });
    suggestRow.appendChild(chip);
  });

  // ---- username auto-suggested from the owner's name -------------------
  // Endowed progress, cheaply: the field is already filled by the time
  // they reach it, so the form reads as shorter than it is. Only ever
  // suggests -- once the wholesaler types their own, we stop touching it.
  let userTouched = false;
  $("cf-user").addEventListener("input", () => { userTouched = true; });
  $("cf-owner").addEventListener("input", () => {
    if (userTouched) return;
    const first = $("cf-owner").value.trim().split(/\s+/)[0] || "";
    $("cf-user").value = first.toLowerCase().replace(/[^a-z0-9]/g, "");
  });

  // ---- more details fold ----------------------------------------------
  $("cf-more-toggle").addEventListener("click", () => {
    const box = $("cf-more");
    box.hidden = !box.hidden;
    $("cf-more-toggle").innerHTML = box.hidden
      ? `▸ Add more details <span style="color:var(--text-tertiary);font-weight:400;">(optional)</span>`
      : `▾ Hide extra details`;
  });

  // ---- generate a password in the browser ------------------------------
  // Only a convenience so the wholesaler can SEE it before saving. The
  // authoritative generation is server-side when this field is left
  // empty; this one is never trusted for anything.
  $("cf-gen").addEventListener("click", () => {
    const abc = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const buf = new Uint32Array(12);
    crypto.getRandomValues(buf);
    $("cf-pass").value = Array.from(buf, (n) => abc[n % abc.length]).join("");
  });

  // ---- save -------------------------------------------------------------
  $("cf-save").addEventListener("click", async () => {
    const err = $("cf-error");
    err.textContent = "";

    const shop  = $("cf-shop").value.trim();
    const owner = $("cf-owner").value.trim();
    const phone = $("cf-phone").value.trim();
    const list  = sells.getValues();
    const user  = $("cf-user").value.trim();

    // Checked here for a fast, specific message; checked AGAIN in
    // v2_create_client, which is the one that actually decides.
    const missing = [];
    if (!shop)  missing.push("company name");
    if (!owner) missing.push("owner name");
    if (!phone) missing.push("owner phone");
    if (!list.length) missing.push("what they sell");
    if (!user)  missing.push("username");
    if (missing.length) {
      err.textContent = "Still needed: " + missing.join(", ") + ".";
      return;
    }

    const extra = {
      city: $("cf-city").value.trim(),
      area: $("cf-area").value.trim(),
      address: $("cf-address").value.trim(),
      phone2: $("cf-phone2").value.trim(),
      email: $("cf-email").value.trim(),
      instagram: $("cf-instagram").value.trim(),
      business_type: $("cf-btype").value,
      branches: $("cf-branches").value.trim(),
      years_in_business: $("cf-years").value.trim(),
      language: $("cf-lang").value,
      note: $("cf-note").value.trim(),
    };

    const btn = $("cf-save");
    btn.disabled = true; btn.textContent = "Adding…";

    const res = await createClient({
      shopName: shop, ownerName: owner, phone, sells: list, username: user,
      password: $("cf-pass").value.trim() || null,
      discountPct: Number($("cf-discount").value || 0),
      accessTier: Number($("cf-tier").value || 1),
      extra,
    });

    btn.disabled = false; btn.textContent = "Add client";

    if (!res.ok) {
      // Deliberately does NOT clear the form. Re-typing eight fields
      // because one was a duplicate is the single most avoidable reason
      // people give up on a form.
      err.textContent = res.msg || "Could not add this client.";
      return;
    }

    showCredentials({
      shopName: shop,
      ownerName: owner,
      phone,
      username: res.username,
      password: res.temp_password || $("cf-pass").value.trim(),
      wasGenerated: !!res.temp_password,
    });

    // Reset for the next one -- wholesalers add clients in batches.
    ["cf-shop","cf-owner","cf-phone","cf-user","cf-pass","cf-city","cf-area","cf-address",
     "cf-phone2","cf-email","cf-instagram","cf-branches","cf-years","cf-discount","cf-note"]
      .forEach((id) => { const el = $(id); if (el) el.value = ""; });
    sells.clear();
    userTouched = false;
    $("cf-shop").focus();

    onCreated();
  });

  return card;
}

// ---------------------------------------------------------------------
// The one and only time this password exists in readable form.
// ---------------------------------------------------------------------
function showCredentials({ shopName, ownerName, phone, username, password, wasGenerated }) {
  const back = document.createElement("div");
  back.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1100;padding:16px;";

  const waText = `Hi ${ownerName}, your account is ready.\nUsername: ${username}\nPassword: ${password}\nYou'll be asked to change the password when you sign in.`;
  const waHref = `https://wa.me/${String(phone).replace(/\D/g, "")}?text=${encodeURIComponent(waText)}`;

  const box = document.createElement("div");
  box.className = "card";
  box.style.cssText = "max-width:440px;width:100%;padding:22px;";
  box.innerHTML = `
    <div style="font-size:17px;font-weight:700;margin-bottom:4px;">${esc(shopName)} is set up</div>
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;">
      ${wasGenerated ? "This password was generated just now and is shown <b>once</b>." : "Keep this somewhere safe — it is shown <b>once</b>."}
      After you close this, it can only be reset, never read back.
    </div>
    <div style="background:var(--surface-2,rgba(0,0,0,.04));border-radius:8px;padding:14px;margin-bottom:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      <div style="font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.04em;">Username</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:10px;">${esc(username)}</div>
      <div style="font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.04em;">Password</div>
      <div style="font-size:15px;font-weight:600;" id="cred-pass">${esc(password)}</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
      <button class="btn btn-ghost btn-sm" id="cred-copy">Copy both</button>
      <a class="btn btn-ghost btn-sm" id="cred-wa" href="${esc(waHref)}" target="_blank" rel="noopener">Send on WhatsApp</a>
    </div>
    <div style="font-size:12px;color:var(--text-secondary);background:var(--surface-2,rgba(0,0,0,.03));border-radius:6px;padding:10px;margin-bottom:14px;">
      They will be asked to choose their own password the first time they sign in, so this one
      stops working after that.
    </div>
    <button class="btn btn-primary" id="cred-done" style="width:100%;">I've saved it — close</button>
  `;
  back.appendChild(box);
  // Batch 8A. This sheet shows a password that appears NOWHERE else, ever.
  // Leaving it orphaned over another screen was the mild version of the risk;
  // the real one is that it used to survive a navigation, so the person could
  // wander off, come back, and find a credential dialog they no longer had
  // any context for.
  openModal(back, { label: "New client sign-in details" });

  box.querySelector("#cred-copy").addEventListener("click", async () => {
    const btn = box.querySelector("#cred-copy");
    try {
      await navigator.clipboard.writeText(`Username: ${username}\nPassword: ${password}`);
      btn.textContent = "Copied";
    } catch (e) {
      // Clipboard can be refused (permissions, insecure context). Say so
      // rather than pretending it worked -- they are about to close the
      // only screen this password ever appears on.
      btn.textContent = "Copy failed — select it by hand";
    }
    setTimeout(() => { btn.textContent = "Copy both"; }, 2500);
  });

  // No click-outside-to-dismiss, and no Escape. Every other dialog in this
  // app closes that way; this one must not, because a stray click would
  // destroy the only copy of the password.
  box.querySelector("#cred-done").addEventListener("click", () => closeModal(back));
}
