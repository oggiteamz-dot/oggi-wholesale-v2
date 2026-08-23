// =============================================================================
// OGGI Wholesale v2 — ask() and confirmAction()     (Batch 8A, 23 Aug 2026)
// =============================================================================
//
// The two in-app replacements for the browser's prompt() and confirm().
//
// WHY THE NATIVE ONES HAD TO GO — all five reasons, because "they're ugly" is
// the least important of them:
//
//   1. THEY BLOCK THE PAGE THREAD. Nothing renders, no timer fires, no
//      network callback runs while one is open. On a slow phone the app looks
//      frozen behind the box.
//   2. NO GATE CAN TEST THEM. There is no DOM to assert against, so every
//      flow that ran through a prompt was untested by construction — which is
//      exactly where the receive-stock defect had been hiding since Batch 9.
//   3. ON A PHONE THEY READ AS THE BROWSER, NOT THE APP. A grey system sheet
//      saying "oggi-wholesale-v2.workers.dev says:" above the question. People
//      dismiss those; they have been trained to.
//   4. confirm() LABELS ITS BUTTONS "OK" AND "CANCEL". The most dangerous
//      action in the app and the way out of it are labelled by the browser,
//      identically, whatever the question was. A destructive action should be
//      confirmed by a button that names the act — "Ban this client", not "OK".
//   5. THEY CANNOT BE STYLED, TRANSLATED, OR MADE RTL. Arabic is on the road
//      map; a native dialog would ignore it.
//
// Both functions return a Promise, so a call site reads almost exactly as it
// did before — `const name = await ask(...)` in place of `const name =
// prompt(...)` — which is what keeps a thirteen-site replacement honest.
// Cancel resolves to null (ask) or false (confirmAction), matching what
// prompt() and confirm() returned, so no call site's null-check changes
// meaning while it is being moved.
// =============================================================================

import { esc } from "../lib/utils.js";
import { openModal, closeModal } from "../lib/modal-stack.js";

/**
 * Ask for one piece of text or a number. The replacement for prompt().
 *
 * @param {object}  o
 * @param {string}  o.title
 * @param {string}  [o.body]         Explanation under the title. Supports \n.
 * @param {string}  [o.label]        Field label. Defaults to the title.
 * @param {string}  [o.value]        Prefilled value.
 * @param {string}  [o.placeholder]
 * @param {"text"|"number"} [o.type]
 * @param {string}  [o.confirmLabel] Defaults to "Save".
 * @param {Function}[o.validate]     (value) => string|null. A returned string
 *                                   is shown as the error and the dialog stays
 *                                   open. This is the thing prompt() could not
 *                                   do at all: it accepted anything, including
 *                                   nothing, and every caller had to re-check
 *                                   afterwards — and several did not.
 * @returns {Promise<string|null>}   null on cancel, exactly like prompt().
 */
export function ask({
  title, body = "", label = "", value = "", placeholder = "",
  type = "text", confirmLabel = "Save", validate = null,
} = {}) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");

    const box = document.createElement("div");
    box.className = "card modal-box";
    box.innerHTML = `
      <div class="modal-title">${esc(title)}</div>
      ${body ? `<div class="modal-sub">${esc(body).replace(/\n/g, "<br>")}</div>` : ""}
      <label class="modal-label" for="ask-input">${esc(label || title)}</label>
      <input class="input" id="ask-input" type="${type === "number" ? "number" : "text"}"
             ${type === "number" ? 'inputmode="numeric"' : ""}
             placeholder="${esc(placeholder)}" autocomplete="off">
      <div class="modal-err" id="ask-err" role="alert"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-a="cancel" type="button">Cancel</button>
        <button class="btn btn-primary" data-a="ok" type="button">${esc(confirmLabel)}</button>
      </div>
    `;
    back.appendChild(box);

    const input = box.querySelector("#ask-input");
    const err = box.querySelector("#ask-err");
    input.value = value ?? "";

    // Resolve exactly once, whatever closes the dialog — the button, Escape,
    // a backdrop click, or a route change. A promise that never settles is a
    // caller stuck on `await` forever, which looks like the app hanging.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      closeModal(back);
    };

    function submit() {
      const v = input.value;
      const problem = validate ? validate(v) : null;
      if (problem) { err.textContent = problem; input.focus(); return; }
      finish(v);
    }

    box.querySelector('[data-a="ok"]').addEventListener("click", submit);
    box.querySelector('[data-a="cancel"]').addEventListener("click", () => finish(null));
    back.addEventListener("click", (e) => { if (e.target === back) finish(null); });
    input.addEventListener("input", () => { err.textContent = ""; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    openModal(back, {
      label: title,
      // Escape and route changes go through the stack, so onClose is where a
      // cancel that did not come from a button gets its answer.
      onClose: () => { if (!settled) { settled = true; resolve(null); } },
    });
    input.focus();
    input.select();
  });
}

/**
 * Ask a yes/no question. The replacement for confirm().
 *
 * @param {object}  o
 * @param {string}  o.title
 * @param {string}  [o.body]
 * @param {string}  [o.confirmLabel] NAME THE ACT. "Ban this client", not "OK".
 *                                   A person clicking a destructive button
 *                                   should be able to read what it does off
 *                                   the button itself.
 * @param {string}  [o.cancelLabel]
 * @param {boolean} [o.danger]       Red confirm button for destructive acts.
 * @returns {Promise<boolean>}       false on cancel, exactly like confirm().
 */
export function confirmAction({
  title, body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false,
} = {}) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-backdrop";
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");

    const box = document.createElement("div");
    box.className = "card modal-box";
    box.innerHTML = `
      <div class="modal-title">${esc(title)}</div>
      ${body ? `<div class="modal-sub">${esc(body).replace(/\n/g, "<br>")}</div>` : ""}
      <div class="modal-actions">
        <button class="btn btn-ghost" data-a="cancel" type="button">${esc(cancelLabel)}</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-a="ok" type="button"
                ${danger ? 'style="background:var(--danger,#b42318);color:#fff;"' : ""}>${esc(confirmLabel)}</button>
      </div>
    `;
    back.appendChild(box);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      closeModal(back);
    };

    box.querySelector('[data-a="ok"]').addEventListener("click", () => finish(true));
    box.querySelector('[data-a="cancel"]').addEventListener("click", () => finish(false));
    back.addEventListener("click", (e) => { if (e.target === back) finish(false); });

    openModal(back, {
      label: title,
      onClose: () => { if (!settled) { settled = true; resolve(false); } },
    });
    // Focus lands on CANCEL, not on the confirming button. A destructive
    // dialog whose dangerous button is pre-focused turns a stray Enter --
    // still held down from whatever opened it -- into a confirmed deletion.
    box.querySelector('[data-a="cancel"]').focus();
  });
}
