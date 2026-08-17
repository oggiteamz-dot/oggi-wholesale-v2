// OGGI Wholesale v2 — "Add wholesaler" screen (CR-0001 R1 / R2 / R3 / R4)
//
// THE SCREEN THAT DID NOT EXIST.
// Before 17 Aug 2026 there was no way to create a wholesaler anywhere in
// this product. The owner's Wholesalers page was a read-only list with a
// Deactivate button, and the Invites page could only invite someone into
// a wholesaler that already existed -- which nothing could create. This
// closes that loop.
//
// WHAT HAPPENS WHEN YOU PRESS "Create wholesaler"
// One call to the `v2_create_wholesaler` database function, which does
// the whole job in a single transaction (login, identity, v1 row, v2 row,
// both role tables, category links). Either the wholesaler exists
// completely or nothing was written and you get a plain-English reason.
// See js/data/wholesaler-admin.js for why it is not six calls from here.
//
// AFTER IT SUCCEEDS
// The credentials panel appears. THIS IS THE ONLY TIME THE PASSWORD IS
// EVER SHOWN -- it is stored hashed and cannot be read back, by anyone,
// including me. Hence the three delivery buttons right there: WhatsApp,
// Copy, and Email (email is dormant until an address is configured --
// see js/data/messaging-settings.js).
//
// FOR WHOEVER EDITS THIS NEXT
// The fields are declared once in FIELDS below and rendered from it. Add
// a field there and it appears; you do not need to touch the markup.

import { toast } from "../components/toast.js";
import { renderCategoryPicker } from "../components/category-picker.js";
import { renderTagInput } from "../components/tag-input.js";
import { setBrands } from "../data/brands.js";
import { createWholesaler } from "../data/wholesaler-admin.js";
import { listCategories } from "../data/categories.js";
import { esc, pageHeader } from "../lib/utils.js";

// Field definitions. `key` matches what createWholesaler() expects.
const FIELDS = [
  { key: "handle",   label: "Short handle",  required: true,  width: 200,
    hint: "Lowercase, no spaces. Becomes their login and their ID — e.g. \"square\" gives square@oggiwholesale.app. Cannot be changed later." },
  { key: "brand",    label: "Brand name",    required: true,  width: 240,
    hint: "What buyers see." },
  { key: "name",     label: "Company name",  required: false, width: 240,
    hint: "Legal or full name, if different. Leave blank to reuse the brand." },
  { key: "industry", label: "Industry",      required: false, width: 200,
    hint: "The trade they're in, e.g. Fashion." },
  { key: "location", label: "Location",      required: false, width: 240,
    hint: "Free text — district and city is usually more useful than a country." },
  { key: "phone",    label: "WhatsApp number", required: false, width: 200,
    hint: "Digits with country code, no + or spaces, e.g. 96170123456. Used to send their login." },
  { key: "email",    label: "Their email",   required: false, width: 240,
    hint: "Optional. Leave blank if you don't have it — you can add it later." },
  { key: "currency", label: "Currency",      required: false, width: 90, value: "$" },
];

function field(f) {
  const wrap = document.createElement("div");
  wrap.style.cssText = `display:flex;flex-direction:column;gap:4px;`;
  wrap.innerHTML = `
    <label style="font-size:11px;color:var(--text-tertiary);">
      ${esc(f.label)}${f.required ? ' <span style="color:var(--danger);">*</span>' : ""}
    </label>
    <input class="input" id="nw-${f.key}" style="width:${f.width}px;max-width:100%;" value="${esc(f.value || "")}" />
    ${f.hint ? `<span style="font-size:11px;color:var(--text-tertiary);max-width:${f.width}px;">${esc(f.hint)}</span>` : ""}
  `;
  return wrap;
}

export async function newWholesalerView(outlet) {
  outlet.appendChild(pageHeader(
    "Add wholesaler",
    "Creates their account, their login, and their categories in one step."
  ));

  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "padding:18px;margin-bottom:16px;";

  const grid = document.createElement("div");
  grid.style.cssText = "display:flex;flex-wrap:wrap;gap:16px;margin-bottom:18px;";
  FIELDS.forEach((f) => grid.appendChild(field(f)));
  card.appendChild(grid);

  // ---- password -----------------------------------------------------
  const pwWrap = document.createElement("div");
  pwWrap.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:18px;";
  pwWrap.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:4px;">
      <label style="font-size:11px;color:var(--text-tertiary);">Password <span style="color:var(--danger);">*</span></label>
      <input class="input" id="nw-password" style="width:260px;" />
      <span style="font-size:11px;color:var(--text-tertiary);max-width:260px;">
        At least 8 characters. Shown to you once after creating — it can never be read back afterwards.
      </span>
    </div>
  `;
  const genBtn = document.createElement("button");
  genBtn.type = "button";
  genBtn.className = "btn btn-ghost btn-sm";
  genBtn.textContent = "Suggest one";
  genBtn.addEventListener("click", () => {
    // Readable-but-strong: two words, four digits. Easy to send over
    // WhatsApp and read back over a phone call without confusion.
    const words = ["Cedar", "Beirut", "Olive", "Marble", "Harbour", "Amber", "Cotton", "Linen", "Ivory", "Cobalt"];
    const a = words[Math.floor(Math.random() * words.length)];
    const b = words[Math.floor(Math.random() * words.length)];
    document.getElementById("nw-password").value = `${a}-${b}-${Math.floor(1000 + Math.random() * 9000)}`;
  });
  pwWrap.appendChild(genBtn);
  card.appendChild(pwWrap);

  // ---- categories ---------------------------------------------------
  const catWrap = document.createElement("div");
  catWrap.style.cssText = "margin-bottom:18px;";
  catWrap.innerHTML = `
    <label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:6px;">
      What do they sell? — tap as many as apply, or type your own
    </label>
  `;
  const presets = await listCategories();
  const picker = renderCategoryPicker({ presets });
  catWrap.appendChild(picker.el);
  card.appendChild(catWrap);

  // ---- brands they carry --------------------------------------------
  // A wholesaler is not one label. A real one here carries Nike, Dsquared,
  // Emporio and four more on a single account. v2_wholesalers.brand stays
  // the PRIMARY display name (login screen, invoice); this is the list of
  // houses they stock, which is a different fact and lives in its own table.
  const brandWrap = document.createElement("div");
  brandWrap.style.cssText = "margin-bottom:18px;";
  brandWrap.innerHTML = `
    <label style="font-size:11px;color:var(--text-tertiary);display:block;margin-bottom:6px;">
      Brands they carry — type one and press Enter, as many as you need
    </label>
  `;
  const brandInput = renderTagInput({ placeholder: "e.g. Nike" });
  brandWrap.appendChild(brandInput.el);
  card.appendChild(brandWrap);

  // ---- private notes ------------------------------------------------
  const notesWrap = document.createElement("div");
  notesWrap.style.cssText = "margin-bottom:18px;display:flex;flex-direction:column;gap:4px;";
  notesWrap.innerHTML = `
    <label style="font-size:11px;color:var(--text-tertiary);">Your private notes</label>
    <textarea class="input" id="nw-notes" rows="2" style="width:100%;max-width:520px;"></textarea>
    <span style="font-size:11px;color:var(--text-tertiary);">Only you see this. The wholesaler never does.</span>
  `;
  card.appendChild(notesWrap);

  // ---- submit -------------------------------------------------------
  const submit = document.createElement("button");
  submit.className = "btn btn-primary";
  submit.textContent = "Create wholesaler";
  card.appendChild(submit);

  const result = document.createElement("div");
  result.style.marginTop = "16px";
  card.appendChild(result);

  outlet.appendChild(card);

  submit.addEventListener("click", async () => {
    const val = (k) => (document.getElementById(`nw-${k}`)?.value || "").trim();
    const form = {
      handle: val("handle").toLowerCase(),
      brand: val("brand"),
      password: val("password"),
      name: val("name"),
      industry: val("industry"),
      location: val("location"),
      phone: val("phone").replace(/[^0-9]/g, ""),  // wa.me wants digits only
      email: val("email"),
      currency: val("currency") || "$",
      categories: picker.getSelected(),
      brands: brandInput.getValues(),
      notes: val("notes"),
    };

    submit.disabled = true;
    submit.textContent = "Creating…";
    const res = await createWholesaler(form);
    submit.disabled = false;
    submit.textContent = "Create wholesaler";

    if (!res.ok) {
      // The database sends back a sentence meant for a human. Show it as
      // it is rather than replacing it with a generic failure message.
      toast(res.error || "Could not create the wholesaler", { type: "danger" });
      result.innerHTML = `<div class="card" style="padding:12px;border-left:3px solid var(--danger);">
        <strong>Not created.</strong> ${esc(res.error)}
      </div>`;
      return;
    }

    // The create RPC does not take brands -- the wholesaler has to exist
    // before rows can reference its wid -- so this is a second call. It is
    // reported separately and honestly: if it fails, the wholesaler WAS
    // created and only the brand list is missing. Saying "created" and
    // silently dropping seven brands is exactly the class of quiet loss this
    // build is trying to stamp out.
    let brandNote = "";
    if (form.brands.length) {
      const b = await setBrands(res.wid, form.brands);
      if (!b.ok) {
        brandNote = b.error || "the brand list could not be saved";
        toast(`Created, but ${brandNote}`, { type: "danger" });
      }
    }
    toast(`${form.brand} created`, { type: "success" });
    renderCredentials(result, { ...form, loginEmail: res.loginEmail, wid: res.wid });
    picker.clear();
    brandInput.clear();
    FIELDS.forEach((f) => { const el = document.getElementById(`nw-${f.key}`); if (el) el.value = f.value || ""; });
    document.getElementById("nw-password").value = "";
    document.getElementById("nw-notes").value = "";
  });
}

/**
 * The one and only time this password is visible. Deliberately replaces
 * the area rather than using a toast, which would disappear on its own
 * and take the password with it.
 */
function renderCredentials(host, w) {
  const message =
    `Hi ${w.brand}, your OGGI Wholesale account is ready.\n\n` +
    `Login: ${w.loginEmail}\n` +
    `Password: ${w.password}\n\n` +
    `Sign in here: https://oggi-wholesale-v2.oggi-teamz.workers.dev\n` +
    `Use the "Owner / Wholesaler" tab.`;

  host.innerHTML = `
    <div class="card" style="padding:16px;border-left:3px solid var(--success);">
      <div style="font-weight:650;margin-bottom:6px;">✅ ${esc(w.brand)} created</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">
        Send these now — <strong>the password cannot be shown again</strong>. It is stored scrambled and
        nobody can read it back, so if it is lost you will need to set a new one.
      </div>
      <div style="font-family:monospace;font-size:13px;background:var(--surface-sunken,#f7f7f5);border-radius:8px;padding:10px 12px;">
        <div>Login: <strong>${esc(w.loginEmail)}</strong></div>
        <div>Password: <strong>${esc(w.password)}</strong></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
        <a class="btn btn-primary btn-sm" id="cred-wa" target="_blank" rel="noopener">Send on WhatsApp</a>
        <button class="btn btn-secondary btn-sm" id="cred-copy">Copy message</button>
        <button class="btn btn-ghost btn-sm" id="cred-email" disabled title="Email is not configured yet">Send by email</button>
      </div>
      <div style="font-size:11px;color:var(--text-tertiary);margin-top:8px;" id="cred-note"></div>
    </div>
  `;

  const wa = host.querySelector("#cred-wa");
  if (w.phone) {
    wa.href = `https://wa.me/${w.phone}?text=${encodeURIComponent(message)}`;
  } else {
    // No number: don't show a button that goes nowhere.
    wa.classList.add("btn-ghost");
    wa.classList.remove("btn-primary");
    wa.removeAttribute("href");
    wa.style.opacity = "0.5";
    wa.style.pointerEvents = "none";
    wa.title = "No WhatsApp number was entered";
  }

  host.querySelector("#cred-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(message);
    toast("Message copied — paste it wherever you like", { type: "success" });
  });

  // Email stays disabled and SAYS why, rather than pretending to send.
  host.querySelector("#cred-note").textContent =
    "Email sending isn't switched on yet. Once you add a sending address in Messaging, this button turns on and can send automatically.";
}
