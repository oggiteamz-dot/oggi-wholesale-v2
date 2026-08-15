// OGGI Wholesale v2 — toast notifications
let stack = null;

function ensureStack() {
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(message, { type = "default", duration = 2600 } = {}) {
  const el = document.createElement("div");
  el.className = `toast${type !== "default" ? " toast-" + type : ""}`;
  el.textContent = message;
  ensureStack().appendChild(el);
  setTimeout(() => el.remove(), duration);
}
