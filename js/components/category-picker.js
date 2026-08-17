// OGGI Wholesale v2 — category picker (CR-0001 R2)
//
// WHAT HADI ASKED FOR, in his words: "either I get to write it manually
// and get options, or there are presets so I either write it or I just
// click on the presets and I can click multiple presets, because a
// wholesaler can have multiple different categories that they sell".
//
// So this does BOTH, in one control:
//   * every preset shows as a chip you tap to select or unselect
//   * a text box types a new one; matching presets filter as you type
//   * Enter (or the Add button) adds whatever you typed, even if it is
//     not a preset -- new names are created when the form is submitted
//   * selection is always MULTIPLE
//
// It is a component, not part of the form, because the edit screen and
// the public signup page both need the same control. One copy means one
// place to fix -- this codebase has been bitten before by ten copies of
// the same helper drifting apart.
//
// USAGE
//   const picker = renderCategoryPicker({ presets, selected: [], onChange });
//   container.appendChild(picker.el);
//   picker.getSelected();   // -> ["Womenswear", "Denim"]  (names)
//
// It deals in NAMES, not ids, because `createWholesaler` takes names and
// lets the database create anything new inside the same transaction.

import { esc } from "../lib/utils.js";

export function renderCategoryPicker({ presets = [], selected = [], onChange = () => {} } = {}) {
  // Held as a Map of lowercased-name -> original casing, so "denim" typed
  // by hand cannot end up as a second entry next to the "Denim" chip.
  const chosen = new Map();
  selected.forEach((n) => chosen.set(n.toLowerCase(), n));

  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;gap:8px;";

  // --- the box showing what is currently selected -------------------
  const selectedBox = document.createElement("div");
  selectedBox.style.cssText =
    "display:flex;flex-wrap:wrap;gap:6px;min-height:34px;padding:6px;border:1px solid var(--border-subtle);border-radius:8px;";

  // --- type-to-add / type-to-filter --------------------------------
  const inputRow = document.createElement("div");
  inputRow.style.cssText = "display:flex;gap:8px;";
  const input = document.createElement("input");
  input.className = "input";
  input.placeholder = "Type a category, or tap one below…";
  input.style.cssText = "flex:1;min-width:0;";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-secondary btn-sm";
  addBtn.textContent = "Add";
  inputRow.append(input, addBtn);

  // --- the preset chips ---------------------------------------------
  const presetBox = document.createElement("div");
  presetBox.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";

  function notify() { onChange(getSelected()); }

  function add(name) {
    const clean = (name || "").trim();
    if (!clean) return;
    if (!chosen.has(clean.toLowerCase())) {
      chosen.set(clean.toLowerCase(), clean);
      renderSelected(); renderPresets(); notify();
    }
    input.value = "";
    renderPresets();
  }

  function remove(key) { chosen.delete(key); renderSelected(); renderPresets(); notify(); }

  function renderSelected() {
    selectedBox.innerHTML = "";
    if (!chosen.size) {
      selectedBox.innerHTML =
        `<span style="font-size:12px;color:var(--text-tertiary);align-self:center;padding-left:4px;">Nothing selected yet</span>`;
      return;
    }
    chosen.forEach((label, key) => {
      const chip = document.createElement("span");
      chip.className = "badge badge-accent";
      chip.style.cssText = "display:inline-flex;align-items:center;gap:6px;padding:4px 8px;";
      chip.innerHTML = `${esc(label)}<span style="cursor:pointer;font-weight:700;" title="Remove">×</span>`;
      chip.querySelector("span").addEventListener("click", () => remove(key));
      selectedBox.appendChild(chip);
    });
  }

  function renderPresets() {
    const filter = input.value.trim().toLowerCase();
    presetBox.innerHTML = "";
    const shown = presets.filter((p) => !filter || p.name.toLowerCase().includes(filter));

    if (!shown.length) {
      presetBox.innerHTML =
        `<span style="font-size:12px;color:var(--text-tertiary);">No preset matches — press Add to create "${esc(input.value.trim())}".</span>`;
      return;
    }

    shown.forEach((p) => {
      const isOn = chosen.has(p.name.toLowerCase());
      const chip = document.createElement("button");
      chip.type = "button";  // never submit the form it sits inside
      chip.className = isOn ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm";
      chip.textContent = p.name;
      chip.addEventListener("click", () => (isOn ? remove(p.name.toLowerCase()) : add(p.name)));
      presetBox.appendChild(chip);
    });
  }

  addBtn.addEventListener("click", () => add(input.value));
  input.addEventListener("input", renderPresets);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    // Stop Enter submitting the surrounding form -- adding a category is
    // almost never the same intention as saving the whole wholesaler.
    e.preventDefault();
    add(input.value);
  });

  function getSelected() { return Array.from(chosen.values()); }

  el.append(selectedBox, inputRow, presetBox);
  renderSelected(); renderPresets();

  return { el, getSelected, add, clear: () => { chosen.clear(); renderSelected(); renderPresets(); notify(); } };
}
