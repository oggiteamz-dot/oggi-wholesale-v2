// =============================================================================
// OGGI Wholesale v2 — MODAL STACK                  (Batch 8A, 23 Aug 2026)
// =============================================================================
//
// WHAT THIS IS, IN ONE LINE
// -------------------------
// The single place a dialog is put on screen, so that "a dialog closes when
// you navigate" is a property of the MECHANISM instead of something every
// call site had to remember on its own.
//
// WHY IT EXISTS
// -------------
// On the morning of 23 Aug 2026 a product edit form was found sitting open
// over the dashboard, belonging to a screen that was no longer there.
//
// The cause was not that anyone forgot to close it. The app had four separate
// ways to open a dialog, and only ONE of them defended itself:
//
//   openProductPanel()  (the packs drawer)   — listened for "v2:navigated" ✅
//   overlayHost()       (product view, product editor) — did not            ❌
//   openBanDialog()                                    — did not            ❌
//   openTransfer()                                     — did not            ❌
//
// A dialog is appended to document.body. Re-rendering the view underneath it
// therefore does not remove it: document.body is not the view. So any
// navigation while one is open leaves it floating over whatever loads next.
//
// Defending one of four is how the other three bite. Three of them were still
// undefended, and the trapdoor that triggered it (the "N on hand" link inside
// the edit form) went through the one that was NOT defended.
//
// THE RULE THIS FILE ENFORCES
// ---------------------------
//   A route change closes every open dialog. Always. Whatever caused it.
//
// It is enforced here, once, rather than asserted about four functions —
// because the fifth dialog somebody writes next month gets it for free, and
// no reviewer has to notice that it needs it.
//
// WHY A STACK RATHER THAN A SINGLE SLOT
// -------------------------------------
// Dialogs genuinely nest: a confirmation opened from inside the product
// editor is a second dialog on top of the first. With a single slot, opening
// the confirm would destroy the editor behind it and the wholesaler would
// lose everything they had typed. So:
//
//   Escape          closes the TOP dialog only
//   navigation      closes ALL of them
//   body scroll     locked by the FIRST, released by the LAST
//
// That last point is the one that is easy to get wrong. If each dialog saved
// and restored `body.style.overflow` independently, closing an inner dialog
// would restore the value it captured — which was already "hidden", because
// the outer dialog had set it. The page would then stay unscrollable with
// nothing on screen to explain why. The stack captures the original value
// once, on the way in, and restores it once, on the way out.
//
// ACCESSIBILITY
// -------------
// Focus returns to whatever opened the dialog. Losing focus to <body> after
// a dialog closes is a real barrier: a keyboard or screen-reader user is
// dropped at the top of the document with no idea where they were.
// =============================================================================

/**
 * The open dialogs, oldest first. Each entry:
 *   { el, onClose, returnFocus, label }
 * @type {Array<{el: HTMLElement, onClose: Function|null, returnFocus: Element|null, label: string}>}
 */
const stack = [];

/** The value of document.body.style.overflow before the FIRST dialog opened.
 *  Captured once, restored once. See the note above about nesting. */
let overflowBeforeFirst = null;

/** The current hash path, in the same shape js/lib/router.js reports it, so
 *  the two cannot disagree about what "the current route" means. Read from
 *  location rather than imported from the router to keep this file free of
 *  any dependency — a modal stack that imports the router, while the router's
 *  consumers import the modal stack, is a cycle waiting to happen. */
function currentPath() {
  const hash = (typeof window !== "undefined" && window.location.hash) || "#/";
  return hash.slice(1) || "/";
}

/** Global listeners are attached lazily on the first open and never removed —
 *  they are two listeners for the lifetime of the page, and attaching or
 *  detaching them per dialog is one more thing that can be got wrong during
 *  a rapid open/close. They no-op when the stack is empty. */
let listenersAttached = false;

function attachListenersOnce() {
  if (listenersAttached) return;
  listenersAttached = true;

  // Escape closes the top dialog only. `capture` is deliberate: an input
  // inside the dialog may stop the event bubbling (a tag editor clearing its
  // own draft on Escape, for instance), and the dialog must still close.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || stack.length === 0) return;
    closeTopModal();
  }, true);

  // THE REASON THIS FILE EXISTS.
  //
  // js/lib/router.js dispatches "v2:navigated" on document after every
  // resolved route. Anything that moves the app — a nav click, the back
  // button, a router.go() from inside a view, a stray location.hash
  // assignment — goes through that one point, so listening here catches
  // every cause rather than the causes anyone thought of.
  document.addEventListener("v2:navigated", (ev) => {
    if (!stack.length) return;
    const now = ev?.detail?.path ?? currentPath();
    // "Closes on navigation" means closes when you navigate AWAY from where it
    // was opened -- not "closes on every navigation event".
    //
    // The difference is not academic. A dialog that IS a route (the packs and
    // ratios drawer at /wholesaler/catalogs/:id/product/:pid/packs) is opened
    // by that route's own render, and js/lib/router.js dispatches this event
    // immediately AFTER the render returns. A blanket close would therefore
    // shut the drawer in the same tick it opened, and the symptom -- a button
    // that visibly does nothing -- is precisely the bug this batch is fixing.
    //
    // Deferring the open with a setTimeout would also "work", and would be a
    // race dressed up as a fix. Comparing paths states the actual rule.
    for (const entry of [...stack].reverse()) {
      if (entry.openPath !== now) closeModal(entry.el);
    }
  });
}

/**
 * Put a dialog on screen and take responsibility for closing it.
 *
 * @param {HTMLElement} el        The dialog root. Appended to document.body
 *                                as-is — this function does not build markup,
 *                                so every existing dialog keeps its own look.
 * @param {object}   [opts]
 * @param {string}   [opts.label]        For debugging and for aria-label if the
 *                                       element does not already carry one.
 * @param {Function} [opts.onClose]      Run when this dialog closes, however it
 *                                       closes. Use it to release anything the
 *                                       caller owns (timers, object URLs, a
 *                                       camera stream).
 * @param {boolean}  [opts.lockScroll=true]
 * @returns {Function} A close function for this specific dialog. Safe to call
 *                     twice — the second call does nothing.
 */
export function openModal(el, opts = {}) {
  const { label = "dialog", onClose = null, lockScroll = true } = opts;
  attachListenersOnce();

  // Capture the focused element BEFORE the dialog enters the document, so
  // focus can be handed back to whatever the person was actually on.
  const returnFocus = document.activeElement;

  if (lockScroll && stack.length === 0) {
    overflowBeforeFirst = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }

  if (!el.getAttribute("aria-label") && label) el.setAttribute("aria-label", label);
  document.body.appendChild(el);
  // openPath is what makes "closes when you navigate away" precise. See the
  // v2:navigated listener above for why "away" rather than "at all".
  stack.push({ el, onClose, returnFocus, label, openPath: currentPath() });

  return () => closeModal(el);
}

/**
 * Close one specific dialog, wherever it sits in the stack.
 *
 * Closing something from the middle of the stack is unusual but legal (a
 * background task finishing, say), and it must not disturb the ones above it.
 */
export function closeModal(el) {
  const i = stack.findIndex((m) => m.el === el);
  if (i === -1) return;          // already closed — calling twice is harmless
  const [entry] = stack.splice(i, 1);

  entry.el.remove();
  // The caller's cleanup runs even if it throws, so one bad handler cannot
  // strand every dialog after it in the DOM.
  try { entry.onClose?.(); } catch (e) { console.error(`[modal-stack] onClose for "${entry.label}" threw:`, e); }

  if (stack.length === 0) {
    if (overflowBeforeFirst !== null) {
      document.body.style.overflow = overflowBeforeFirst;
      overflowBeforeFirst = null;
    }
    if (entry.returnFocus && document.contains(entry.returnFocus) && typeof entry.returnFocus.focus === "function") {
      entry.returnFocus.focus();
    }
  }
}

/** Close the topmost dialog. What Escape does. */
export function closeTopModal() {
  const top = stack[stack.length - 1];
  if (top) closeModal(top.el);
}

/**
 * Close every open dialog. What a route change does.
 *
 * Iterates from the top down so each close sees a consistent stack, and
 * snapshots the list first — closeModal() splices the array it is walking.
 */
export function closeAllModals() {
  for (const entry of [...stack].reverse()) closeModal(entry.el);
}

/** How many dialogs are open. Used by the gate, and by callers that need to
 *  know whether they are the outermost one. */
export function modalDepth() {
  return stack.length;
}
