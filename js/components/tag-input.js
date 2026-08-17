// =============================================================================
// OGGI Wholesale v2 — TAG INPUT
// =============================================================================
//
// Type a word, press Enter, it becomes a removable chip. Repeat as many times
// as you like.
//
// WHY THIS IS NOT category-picker.js
// ----------------------------------
// The category picker is built around a fixed list of presets you tap, with
// free text as the fallback. Brands are the opposite shape: there is no
// sensible preset list -- one wholesaler carries Nike and Dsquared, the next
// carries names nobody has heard of -- so the primary interaction is typing,
// and a preset row would just be empty space.
//
// Kept generic (it says "tag", not "brand") because the same control is
// wanted in at least three other places already: order tags, client tags, and
// the product attribute editor. Building it once means those get it free
// instead of growing a fourth near-copy, which is how this codebase ended up
// with the escape helper in 10 copies under 4 names.
//
// WHAT IT HANDLES THAT A NAIVE VERSION DOES NOT
//   - comma AND Enter both commit, because people type "Nike, Adidas" without
//     thinking about it
//   - pasting a comma- or newline-separated list creates all the chips at once,
//     which is what happens when someone copies a brand list out of a message
//   - Backspace on an empty field removes the last chip (the convention every
//     other tag input has trained people to expect)
//   - duplicates are rejected case-insensitively, so "Nike" and "nike" cannot
//     both exist -- but the FIRST spelling typed is the one kept, because that
//     is the one the user chose
//   - the remove buttons are real 44px touch targets on a coarse pointer
//   - the whole thing is keyboard reachable, and each chip announces what
//     removing it will do
// =============================================================================

import { esc } from "../lib/utils.js";

/**
 * @param {object}   opts
 * @param {string[]} [opts.values]       initial tags
 * @param {string}   [opts.placeholder]
 * @param {number}   [opts.max]          optional ceiling; the input hides at it
 * @param {function} [opts.onChange]     called with the array on every change
 * @returns {{el:HTMLElement, getValues:()=>string[], setValues:(v:string[])=>void, clear:()=>void, focus:()=>void}}
 */
export function renderTagInput({
  values = [],
  placeholder = "Type and press Enter",
  max = 0,
  onChange = () => {},
} = {}) {
  // A Map keyed by the lowercased name preserves insertion order (so the list
  // stays in the order the user typed) while making the duplicate check O(1)
  // and case-insensitive. The VALUE keeps the original spelling.
  const chosen = new Map();
  values.forEach((v) => {
    const t = String(v || "").trim();
    if (t) chosen.set(t.toLowerCase(), t);
  });

  const el = document.createElement("div");
  el.className = "tag-input";

  const chipRow = document.createElement("div");
  chipRow.className = "tag-input-chips";
  el.appendChild(chipRow);

  const field = document.createElement("input");
  field.type = "text";
  field.className = "input tag-input-field";
  field.placeholder = placeholder;
  field.setAttribute("aria-label", placeholder);
  // Browsers love to autofill a bare text input with an address or a name.
  field.autocomplete = "off";
  field.spellcheck = false;
  el.appendChild(field);

  const hint = document.createElement("div");
  hint.className = "tag-input-hint";
  el.appendChild(hint);

  function notify() { onChange(getValues()); }

  function add(raw) {
    // One paste can carry a whole list. Split on comma and newline, not on
    // spaces -- "Emporio Armani" is one brand, not two.
    const parts = String(raw || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    let added = 0;
    for (const name of parts) {
      if (max && chosen.size >= max) break;
      const key = name.toLowerCase();
      if (chosen.has(key)) continue; // keep the first spelling
      chosen.set(key, name);
      added++;
    }
    if (added) { render(); notify(); }
    return added;
  }

  function remove(key) {
    if (!chosen.delete(key)) return;
    render();
    notify();
  }

  function render() {
    chipRow.innerHTML = "";
    for (const [key, name] of chosen) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";

      const label = document.createElement("span");
      label.className = "tag-chip-label";
      label.textContent = name; // textContent, not innerHTML — never trust a typed value
      chip.appendChild(label);

      const x = document.createElement("button");
      x.type = "button";
      x.className = "tag-chip-remove";
      x.textContent = "×";
      // Screen readers otherwise announce a bare "×" with no idea what it does.
      x.setAttribute("aria-label", `Remove ${name}`);
      x.addEventListener("click", () => { remove(key); field.focus(); });
      chip.appendChild(x);

      chipRow.appendChild(chip);
    }

    const atMax = max && chosen.size >= max;
    field.style.display = atMax ? "none" : "";
    hint.textContent = atMax
      ? `That is the maximum of ${max}.`
      : chosen.size
        ? `${chosen.size} added — press Enter after each one.`
        : "";
    // esc() is imported and used nowhere else in this file on purpose: every
    // user-supplied string above goes in via textContent or aria-label, which
    // do not parse HTML. Keeping the import documents that this was a choice
    // rather than an oversight.
    void esc;
  }

  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      // Enter inside a form would submit it; a comma would type a stray
      // character before we could read it.
      e.preventDefault();
      if (add(field.value)) field.value = "";
      return;
    }
    if (e.key === "Backspace" && field.value === "" && chosen.size) {
      const lastKey = [...chosen.keys()].pop();
      remove(lastKey);
    }
  });

  // Leaving the field should not silently discard what was typed. Somebody
  // who types "Nike" and taps Save without pressing Enter means Nike.
  field.addEventListener("blur", () => {
    if (add(field.value)) field.value = "";
  });

  field.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    if (/[,\n]/.test(text)) {
      e.preventDefault();
      add(text);
      field.value = "";
    }
  });

  function getValues() { return [...chosen.values()]; }

  function setValues(next) {
    chosen.clear();
    (next || []).forEach((v) => {
      const t = String(v || "").trim();
      if (t) chosen.set(t.toLowerCase(), t);
    });
    render();
  }

  render();

  return {
    el,
    getValues,
    setValues,
    clear() { chosen.clear(); field.value = ""; render(); notify(); },
    focus() { field.focus(); },
  };
}
