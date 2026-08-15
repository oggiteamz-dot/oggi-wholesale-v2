// OGGI Wholesale v2 — reusable empty-state block.
// Every unfinished view (there are many, at Batch 0) renders one of these
// instead of a blank page, so the shell is honest about what's not built
// yet rather than looking broken.

export function emptyState({ icon = "🚧", title, body }) {
  const el = document.createElement("div");
  el.className = "empty-state card";
  el.innerHTML = `
    <div class="empty-icon">${icon}</div>
    <h4>${title}</h4>
    <p>${body}</p>
  `;
  return el;
}
