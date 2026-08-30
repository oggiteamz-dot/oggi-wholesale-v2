// =============================================================================
// OGGI Wholesale v2 — HOW YOUR PRODUCTS ARE ORDERED             SR-05, 30 Aug 2026
// =============================================================================
// The published ranking policy. A wholesaler-facing page, permanently in their
// navigation, describing what actually decides the order products appear in.
//
// ==== THIS IS A PROMISE, SO IT HAS TO BE TRUE ==============================
//
// Every claim below is asserted against the code by
// checks/check_ranking_policy.mjs, and every NUMBER is read live from the
// database rather than typed here. That is not belt and braces: a published
// ranking policy that has drifted from the code is not a stale document, it is
// a false statement made in writing to a supplier — the exact exposure the
// 28 August research named as the one that actually reaches a company this
// size. A page nobody checks is worse than no page.
//
// ==== WHAT SHAPED THE WRITING ==============================================
//
// The European Commission's guidance on this kind of disclosure does not bind
// OGGI — P2B almost certainly does not apply to us, and that was settled on
// 28 August. It is borrowed because it is the best-drafted description of what
// a useful disclosure contains:
//
//   - plain language, written for the professional audience actually reading it
//   - not a list of parameters but WHETHER, HOW and TO WHAT EXTENT each matters
//   - the REASONS one parameter outranks another, not just the order
//   - paid influence described separately, and split into direct payment and
//     obligations accepted in exchange for position
//   - "main parameters" must be what is genuinely most important, not a
//     flattering selection
//   - and, explicitly, NOT the algorithm and NOT the exact weightings —
//     "an excess of information can mean that, in effect, no meaningful
//     information is provided"
//
// The last one is why this page is short. It is also why it does not hedge:
// the honest answer to "how do you rank search results" is currently "we barely
// rank them at all", and saying so plainly is worth more than a paragraph that
// implies a sophistication we do not have.
// =============================================================================

import { esc, pageHeader } from "../lib/utils.js";
import { publishedRankingParameters } from "../data/ranking-policy.js";

// The public explanation of each number. Kept HERE and not in the database's
// `note` column on purpose: those notes are written for us, and
// popular_min_buyers' note explains that 3 "is a starting guess for a market
// with 3 buyers in it" — which would publish our buyer count to every supplier
// on the platform. These are written for the supplier.
const EXPLAIN = {
  popular_min_buyers:
    "How many different shops must have bought a product before it can appear under “Popular right now”. Below this it does not qualify at all.",
  popular_window_days:
    "How far back that shelf looks, in days. Older sales do not count — otherwise whatever sold well first would sit there forever and nothing new could ever reach the shelf.",
  popular_max_rows:
    "The most products that shelf will ever show, however many qualify.",
  similar_min_overlap:
    "How many meaningful words two product names must share before either can be offered as similar to the other.",
  similar_max_rows:
    "The most products “More like this” will ever show.",
  similar_per_store_cap:
    "The most results any single wholesaler may contribute to “More like this”. Without a cap, one supplier's catalogue would fill the shelf and the buyer would stop seeing a comparison.",
  similar_price_band_pct:
    "How far apart two prices may be and still count as close, as a percentage. This affects ORDER ONLY — a price never disqualifies a match, because finding a cheaper equivalent is exactly what a buyer is looking for.",
  similar_stop_words:
    "Words ignored when comparing product names, because they carry no meaning in a catalogue.",
};

function section(title, bodyHtml) {
  const el = document.createElement("div");
  el.className = "card";
  el.style.cssText = "padding:16px;margin-bottom:12px;";
  el.innerHTML = `<h2 style="font-size:16px;margin:0 0 8px;">${esc(title)}</h2>${bodyHtml}`;
  return el;
}

async function rankingPolicyView(outlet) {
  outlet.appendChild(pageHeader(
    "How your products are ordered",
    "What decides where your products appear, written down so you can hold us to it.",
  ));

  // ---- 1. the four surfaces, and they are not the same ---------------------
  outlet.appendChild(section("Where order is decided, and by what", `
    <p style="margin:0 0 10px;">There are four places a buyer sees your products, and they work differently.
    Describing them as one thing would be simpler and would not be true.</p>

    <p style="margin:0 0 6px;"><strong>1. Search.</strong> When a buyer searches, we look only inside the
    wholesalers that buyer already has access to. Results come back in three groups, in this order:
    products whose <strong>name</strong> matches, then products whose <strong>category</strong> matches,
    then products whose <strong>item code</strong> matches. Inside each group the order is
    <strong>alphabetical by product name</strong>.</p>
    <p style="margin:0 0 12px;color:var(--text-secondary);">That is the whole of it. There is no quality
    score, no seller rating, no hidden weighting, and nothing you can pay to change. A name match ranks
    above a category match because a buyer typing a word is far more often naming the thing than naming
    the shelf it sits on.</p>

    <p style="margin:0 0 6px;"><strong>2. “Popular right now”.</strong> Ranked by <strong>how many different
    shops</strong> bought a product recently — never by how many times it was bought.</p>
    <p style="margin:0 0 12px;color:var(--text-secondary);">This is the most important single decision on
    this page, so here is the reason. One shop reordering every week is a loyal customer, not a trend. If
    the shelf counted orders, that one shop would decide what every other buyer sees. Counting distinct
    buyers instead means a product reaches that shelf because the market chose it, and it is the reason a
    large order does not buy visibility. Quantity and recency are used only to break ties between products
    that already have the same number of buyers.</p>

    <p style="margin:0 0 6px;"><strong>3. “More like this”.</strong> Matched on <strong>meaningful words
    shared with the product name</strong> the buyer is looking at, with a cap on how many results any one
    wholesaler may contribute.</p>
    <p style="margin:0 0 12px;color:var(--text-secondary);">Price affects the ORDER of those matches and
    never whether something qualifies. A cheaper equivalent is precisely what this shelf exists to surface,
    and filtering it out would make the feature dishonest.</p>

    <p style="margin:0 0 6px;"><strong>4. “Buy it again”.</strong> A buyer's own past orders, most recent
    first.</p>
    <p style="margin:0;color:var(--text-secondary);">Nothing about other wholesalers, and nothing anyone
    can influence.</p>
  `));

  // ---- 2. paid placement — direct remuneration -----------------------------
  outlet.appendChild(section("What can be paid for", `
    <p style="margin:0 0 10px;"><strong>One thing, in one place, and it says so on screen.</strong></p>
    <p style="margin:0 0 10px;">Search results can carry a separate shelf of promoted products, headed
    <em>“Featured by OGGI — we earn a commission on these”</em>. It is capped at <strong>three</strong>
    products, it is always labelled, and it is worked out separately from the ordinary results.</p>
    <p style="margin:0 0 10px;"><strong>Paid placement cannot move an ordinary result.</strong> The ordinary
    list is calculated without any reference to who has paid for anything — turning every promotion off
    would not change its order by one position. That is not a policy we are asking you to take on trust:
    it is asserted by an automated check that fails the build if it ever stops being true.</p>
    <p style="margin:0;"><strong>Nothing else on this platform can be bought.</strong> There is no paid
    placement in “Popular right now”, in “More like this”, or in “Buy it again” — those three shelves are
    asserted never even to consult the promotions table. The moment “popular” can be purchased the word
    stops meaning anything, and every other shelf inherits the doubt.</p>
  `));

  // ---- 3. indirect remuneration -------------------------------------------
  outlet.appendChild(section("What you cannot do to improve your position", `
    <p style="margin:0 0 10px;">There is nothing you can agree to — no exclusivity, no minimum volume, no
    subscription tier, no additional obligation of any kind — that will move your products up an ordinary
    result. No such arrangement exists, and none is offered privately to anyone.</p>
    <p style="margin:0;color:var(--text-secondary);">This is stated because it is the half of the question
    that usually goes unanswered. Being told what can be paid for tells you nothing if position can also
    be traded for commitments, and a supplier who suspects that would be right to discount everything else
    on this page.</p>
  `));

  // ---- 4. does OGGI compete with you? -------------------------------------
  outlet.appendChild(section("Does OGGI rank its own products first?", `
    <p style="margin:0 0 10px;"><strong>OGGI does not sell any products on this platform.</strong> There is
    no OGGI-owned brand here, and nothing in the system that could mark one — so today the question has
    nothing to attach to.</p>
    <p style="margin:0 0 10px;">If that ever changes, it will not change quietly, and it will not change the
    answer above. Own-brand products would appear in their own labelled, capped shelf — the same treatment
    as paid placement — and never inside the ordinary results. This page will say so before it happens,
    not afterwards.</p>
    <p style="margin:0;"><strong>And your sales figures will not be used to decide it.</strong> What sells
    in your shop is not an input to anything OGGI would stock or price. That rule is the single most
    consistently penalised failure in the whole record of marketplace regulation, and we would rather be
    held to it in writing.</p>
  `));

  // ---- 5. THE LIVE NUMBERS -------------------------------------------------
  const nums = document.createElement("div");
  nums.className = "card";
  nums.style.cssText = "padding:16px;margin-bottom:12px;";
  nums.innerHTML = `<h2 style="font-size:16px;margin:0 0 4px;">The numbers, as they stand right now</h2>
    <p style="margin:0 0 10px;color:var(--text-secondary);">Read from the live system each time you open
    this page, so it cannot quietly fall out of date. Every change to any of them is recorded permanently,
    with who made it and why.</p>
    <div data-numbers>Loading…</div>`;
  outlet.appendChild(nums);

  const params = await publishedRankingParameters();
  const slot = nums.querySelector("[data-numbers]");
  if (params === null) {
    // "Could not load" and "there are none" must not look the same.
    slot.textContent = "These could not be loaded just now. Nothing has changed — please reopen this page.";
  } else if (!Object.keys(params).length) {
    slot.textContent = "No ranking parameters are configured.";
  } else {
    slot.innerHTML = Object.keys(params).sort().map((k) => {
      const v = params[k];
      const shown = v.intValue === null || v.intValue === undefined ? (v.textValue || "") : String(v.intValue);
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border-subtle);">
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <span>${esc(EXPLAIN[k] ? k.replace(/_/g, " ") : k)}</span>
          <strong style="text-align:right;word-break:break-word;">${esc(shown)}</strong>
        </div>
        ${EXPLAIN[k] ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:2px;">${esc(EXPLAIN[k])}</div>` : ""}
      </div>`;
    }).join("");
  }

  // ---- 6. how to check us --------------------------------------------------
  outlet.appendChild(section("How to check any of this", `
    <p style="margin:0 0 10px;"><a href="#/wholesaler/visibility"><strong>Search visibility →</strong></a>
    shows how often your products actually appeared in buyers' searches, roughly where, and
    <strong>how often a paid placement appeared alongside them</strong>. It is built from the same records
    the ranking uses, and it is there so that the paragraphs above are checkable by you rather than
    promised by us.</p>
    <p style="margin:0;">If you think a product of yours was placed unfairly, say so and give us the date.
    Every change to every number on this page is timestamped and kept, so “what were the rules that day”
    is a question with an exact answer rather than a matter of recollection.</p>
  `));

  // ---- 7. when this changes ------------------------------------------------
  outlet.appendChild(section("When this changes", `
    <p style="margin:0;">These numbers are expected to change — most of them are first estimates for a
    market we are still learning. What will not change without this page changing with it is the shape:
    ordinary results are never for sale, paid placement is always separate and always labelled, and your
    sales data is never used against you.</p>
  `));
}

export function registerRankingPolicyRoute(router) {
  router.register("/wholesaler/ranking-policy", (outlet) => rankingPolicyView(outlet));
}
