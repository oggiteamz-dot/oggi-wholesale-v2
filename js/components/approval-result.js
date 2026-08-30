// =============================================================================
// OGGI Wholesale v2 — WHAT TO DO AFTER PRESSING APPROVE      AC-01/ID-03, 30 Aug 2026
// =============================================================================
// Approving an access request now has TWO outcomes, and the wholesaler has to
// be told which one happened, because the two ask completely different things
// of them.
//
//   * The applicant already signs in to OGGI. They get a membership; the store
//     appears in their app immediately. THERE IS NOTHING TO SEND. A password
//     panel here would be an instruction to go and do something that cannot be
//     done, and the wholesaler would go looking for a password that was never
//     minted.
//
//   * The applicant has no OGGI account at all — they came through the
//     sign-in screen's "Don't have an account?" form. They get a store-scoped
//     login and a password shown EXACTLY ONCE, which the wholesaler relays by
//     hand, because this build has no transactional email and does not pretend
//     to.
//
// ==== WHY THE PANEL IS A COMPONENT AND NOT TWO BLOCKS OF MARKUP ============
//
// Both review screens -- the wholesaler's own queue and the owner console --
// had their own copy of this panel, and the copies had ALREADY drifted: one
// says "can now buy from you", the other "approved — account created"; one
// reads `var(--bg-sunken)` and the other `var(--surface-sunken,#f7f7f5)`, a
// token that does not exist and has been silently falling back to a hardcoded
// grey. That is the drift README.md's "don't duplicate helpers" section
// describes, caught here before a third copy was written.
//
// ==== THE ONE-TIME REVEAL IS THE REASON THIS REPLACES THE CARD =============
//
// Not a toast. A toast fades, and this string is not recoverable from anywhere
// -- the database stores only its hash. The card is replaced so the credentials
// sit on screen until the wholesaler dismisses them deliberately.
// =============================================================================

/** The panel shown in place of a request card once it has been approved.
 *
 *  @param {string} name     the shop's name, as the wholesaler knows it
 *  @param {object} result   what approveSignupRequest / approveMySignupRequest
 *                           returned: { ok, username, tempPassword, message }
 *  @param {Function} onDismiss
 *  @returns {HTMLElement}
 */
export function approvalResult(name, result, onDismiss) {
  const box = document.createElement("div");
  box.style.cssText = "width:100%;";

  // WHICH OUTCOME IS DECIDED BY THE SERVER, NOT GUESSED FROM THE SHAPE OF THE
  // REQUEST. The browser does not know whether the applicant had an OGGI
  // account; migration 107 does, and it answers by returning no credentials.
  const hasCredentials = !!(result && result.username && result.tempPassword);
  box.setAttribute("data-approval", hasCredentials ? "credentials" : "membership");

  const head = document.createElement("div");
  head.style.cssText = "font-weight:650;margin-bottom:6px;";
  head.textContent = `✅ ${name} can now buy from you`;
  box.appendChild(head);

  const sub = document.createElement("div");
  sub.style.cssText = "font-size:12px;color:var(--text-secondary);margin-bottom:8px;";
  sub.textContent = hasCredentials
    ? "Copy these now — the password will not be shown again. Send them to the shop yourself; nothing is emailed automatically."
    : (result && result.message)
      || "They already sign in to OGGI, so there is no password to send. Your store has just appeared in their app.";
  box.appendChild(sub);

  if (hasCredentials) {
    const creds = document.createElement("div");
    // On the element, not only in the copy. A gate asking "is there a
    // credentials box" must not have to grep for the word "Password" -- the
    // sentence for the OTHER outcome contains it too ("there is no password to
    // send"), which is exactly how the first draft of that assertion went red
    // on correct code.
    creds.setAttribute("data-creds", "");
    creds.style.cssText = "display:flex;gap:16px;flex-wrap:wrap;font-family:monospace;"
      + "font-size:13px;background:var(--bg-sunken);border-radius:8px;padding:10px 12px;";
    // Built with textContent per field rather than one innerHTML string: a
    // generated username is derived from a shop's own name, and a shop name is
    // not something this app gets to assume is safe.
    for (const [label, value] of [["Username", result.username], ["Password", result.tempPassword]]) {
      const cell = document.createElement("div");
      const l = document.createElement("span");
      l.style.color = "var(--text-tertiary)";
      l.textContent = label + " ";
      const v = document.createElement("strong");
      v.textContent = value;
      cell.append(l, v);
      creds.appendChild(cell);
    }
    box.appendChild(creds);
  }

  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn btn-secondary btn-sm";
  done.style.marginTop = "10px";
  done.textContent = "Done";
  done.addEventListener("click", onDismiss);
  box.appendChild(done);

  return box;
}

// THERE IS NO `esc` IMPORT IN THIS FILE AND THAT IS THE POINT. Every value
// above goes in through textContent, so there is nothing to escape: a sink that
// cannot parse markup is a stronger guarantee than an escape helper somebody
// has to remember to call. Both panels this replaces built their credentials
// row with innerHTML.
