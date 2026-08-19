// OGGI Wholesale v2 — "what should the cards show?" (Batch 21)
//
// Hadi: "this is an inventory setting where the wholesaler can click on what
// he wants to see. Like basically filters. He can toggle on price, colours,
// sizes, supplier, sales and orders."
//
// Three is a hard cap, and the control says so before you hit it rather than
// after. When three are on, the rest go disabled with "turn one off first" --
// which is a worse experience than silently swapping one out, and a better one
// than letting someone tick a fourth and then explaining why it vanished.
//
// The chosen order is the order on the card, so ticking price then margin puts
// price on top. That falls out of using an array rather than a Set, and it is
// worth preserving: the first line of a card is the one people actually read.

import { esc } from "../lib/utils.js";
import { CARD_FACTS, locationFacts, MAX_FACTS, normaliseFacts } from "../lib/card-facts.js";

/**
 * @param {object} o
 * @param {string[]} o.selected   current keys, in order
 * @param {Array} o.locations     [{id, name}]
 * @param {(keys: string[]) => Promise<any>} o.onSave
 */
export function renderCardFactsPicker({ selected = [], locations = [], onSave }) {
  const all = [...CARD_FACTS, ...locationFacts(locations)];
  let chosen = normaliseFacts(selected, locations);

  const el = document.createElement("div");
  el.className = "card facts-picker";

  const head = document.createElement("div");
  head.className = "facts-head";
  head.innerHTML = `
    <div>
      <h4>What your product cards show</h4>
      <p>Pick up to ${MAX_FACTS}. They appear in the order you tick them, on every screen that shows product cards.</p>
    </div>`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn btn-secondary btn-sm facts-toggle";
  head.appendChild(toggle);
  el.appendChild(head);

  const body = document.createElement("div");
  body.className = "facts-body";
  body.hidden = true;
  el.appendChild(body);

  const groups = [...new Set(all.map((f) => f.group))];
  groups.forEach((g) => {
    const sec = document.createElement("div");
    sec.className = "facts-group";
    sec.innerHTML = `<h5>${esc(g)}</h5>`;
    const wrap = document.createElement("div");
    wrap.className = "facts-options";
    all.filter((f) => f.group === g).forEach((f) => {
      const lab = document.createElement("label");
      lab.className = "facts-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = f.key;
      box.dataset.factKey = f.key;
      box.addEventListener("change", () => {
        if (box.checked) {
          if (chosen.length >= MAX_FACTS) { box.checked = false; return; }
          chosen.push(f.key);
        } else {
          chosen = chosen.filter((k) => k !== f.key);
        }
        paint();
      });
      const text = document.createElement("span");
      text.textContent = f.label;
      lab.appendChild(box);
      lab.appendChild(text);
      wrap.appendChild(lab);
    });
    sec.appendChild(wrap);
    body.appendChild(sec);
  });

  const foot = document.createElement("div");
  foot.className = "facts-foot";
  const summary = document.createElement("span");
  summary.className = "cat-hint";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-primary btn-sm facts-save";
  save.textContent = "Save";
  foot.appendChild(summary);
  foot.appendChild(save);
  body.appendChild(foot);

  function labelFor(key) {
    return all.find((f) => f.key === key)?.label || key;
  }

  function paint() {
    body.querySelectorAll("input[type=checkbox]").forEach((box) => {
      const on = chosen.includes(box.dataset.factKey);
      box.checked = on;
      // Full: everything not already on goes unavailable, and the reason is
      // written once at the bottom rather than as a tooltip nobody hovers.
      box.disabled = !on && chosen.length >= MAX_FACTS;
      box.closest(".facts-option").classList.toggle("facts-option-off", box.disabled);
    });
    summary.textContent = chosen.length >= MAX_FACTS
      ? `Showing ${chosen.map(labelFor).join(", ")} — turn one off to pick another.`
      : `Showing ${chosen.map(labelFor).join(", ") || "nothing yet"}. ${MAX_FACTS - chosen.length} more available.`;
    toggle.textContent = body.hidden
      ? `Cards show: ${chosen.map(labelFor).join(", ")}`
      : "Close";
  }

  toggle.addEventListener("click", () => { body.hidden = !body.hidden; paint(); });

  save.addEventListener("click", async () => {
    save.disabled = true;
    const res = await onSave(normaliseFacts(chosen, locations));
    save.disabled = false;
    if (res && res.ok === false) { summary.textContent = res.error || "Could not save."; return; }
    body.hidden = true;
    paint();
  });

  paint();
  return { el, current: () => [...chosen] };
}
