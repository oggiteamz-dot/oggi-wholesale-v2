// =============================================================================
// OGGI Wholesale v2 — OWNER: WHOLESALER DRILL-DOWN  (CR-0001 R8/R9/R10)
// =============================================================================
//
// Hadi's ask: "I want to be able to click on my clients and get data from
// there... I want to see all of their information. How many customers do they
// have? How many orders and I get to put the time frame... their top
// performing products... I can click generate and I get a graph over time of
// what products sell how much in what time frame."
//
// Everything on this screen comes from the six SQL functions in migration 039.
// NOTHING is re-computed here. The moment two places can calculate revenue,
// they eventually disagree and no one can tell which screen is lying.
//
// WHY IT DEPENDS ON THE 17 AUG JOIN FIX
// -------------------------------------
// Client figures join orders on client_id. Before 17 Aug they joined on
// buyer_label -- a PERSON'S display name -- against shop_name, a BUSINESS
// name. They almost never match, so every client read back as 0 orders /
// never ordered. Had this screen been built first, it would have faithfully
// displayed those zeros for every real client and looked finished.
//
// A NOTE ON EMPTY STATES
// ----------------------
// This system currently holds one order. Most panels here will be empty for
// most wholesalers, and every empty state says WHY in plain words rather than
// showing a dash. "No orders in this period" and "this wholesaler has no
// clients yet" are different facts and are worded differently -- a dash makes
// them look like the same bug.
// =============================================================================

import { esc } from "../lib/utils.js";
import { supabase, sbCall } from "../lib/supabase-client.js";
import { toast } from "../components/toast.js";
import { renderDateRangeFilter } from "../components/date-range-filter.js";
import { renderLineChart, renderBarChart } from "../components/chart.js";
import { listBrands } from "../data/brands.js";
import {
  getWholesalerSummary, getTopProducts, getTopClients,
  getSalesSeries, getProductSeries, getClientList,
} from "../data/owner-analytics.js";

const money = (n, c = "$") =>
  c + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const when = (iso) => (iso
  ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
  : "never");

/** "as of" stamp. Every figure on screen carries one -- a number with no
 *  timestamp invites the question "is this stale?" and has no answer. */
const stamp = () => new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function card(title, subtitle = "") {
  const el = document.createElement("section");
  el.className = "card detail-card";
  el.innerHTML = `<header class="detail-card-head">
      <h3>${esc(title)}</h3>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
    </header><div class="detail-card-body"></div>`;
  return { el, body: el.querySelector(".detail-card-body") };
}

function statTile(label, value, note = "") {
  return `<div class="card stat-card">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}</div>
    ${note ? `<div class="stat-note">${esc(note)}</div>` : ""}
  </div>`;
}

/**
 * @param {HTMLElement} outlet
 * @param {{wid:string, brand?:string, currency?:string}} wholesaler
 */
export async function wholesalerDetailView(outlet, wholesaler) {
  const wid = wholesaler?.wid;
  const currency = wholesaler?.currency || "$";
  outlet.innerHTML = "";

  if (!wid) {
    outlet.innerHTML = `<div class="empty-state card"><h4>No wholesaler chosen</h4>
      <p>Open this from the Wholesalers list.</p></div>`;
    return;
  }

  // ---- header ------------------------------------------------------------
  const head = document.createElement("div");
  head.className = "page-header";
  head.innerHTML = `
    <div class="page-title-group">
      <h1>${esc(wholesaler.brand || wid)}</h1>
      <p>Everything this wholesaler has done. <span class="detail-stamp">as of ${esc(stamp())}</span></p>
    </div>
    <div class="page-actions"><a class="btn btn-secondary" href="#/owner/wholesalers">← All wholesalers</a></div>`;
  outlet.appendChild(head);

  // Brands they carry, shown high up: it is the fastest answer to "who is
  // this?" and it is the feature that was invisible until today.
  const brandStrip = document.createElement("div");
  brandStrip.className = "detail-brands";
  outlet.appendChild(brandStrip);
  listBrands(wid).then((brands) => {
    if (!brands.length) {
      brandStrip.innerHTML = `<span class="detail-brands-empty">No brands recorded for this wholesaler yet.</span>`;
      return;
    }
    brandStrip.innerHTML = `<span class="detail-brands-label">Carries</span>` +
      brands.map((b) => `<span class="tag-chip"><span class="tag-chip-label">${esc(b.name)}</span></span>`).join("");
  });

  // ---- time frame --------------------------------------------------------
  const filterWrap = document.createElement("div");
  filterWrap.className = "detail-filter";
  outlet.appendChild(filterWrap);

  // ---- panels ------------------------------------------------------------
  const tiles = document.createElement("div");
  tiles.className = "stat-grid";
  outlet.appendChild(tiles);

  const trend = card("Sales over time", "Revenue per period. Empty periods are drawn as zero, not skipped.");
  const products = card("Top products", "By revenue. Hover a bar for units and order count.");
  const productTrend = card("What sells, over time",
    "Up to six products, biggest first. Press Generate — it is a heavier query than the rest of this page.");
  const clients = card("Their customers", "Every client, including the ones who have never ordered.");
  [trend.el, products.el, productTrend.el, clients.el].forEach((e) => outlet.appendChild(e));

  // Generate button, per the ask. Deliberately NOT automatic: the per-product
  // series is the most expensive query here, and firing it on every date
  // change would make the filter feel slow for a chart the operator may not
  // want.
  const genBar = document.createElement("div");
  genBar.className = "detail-generate";
  const genBtn = document.createElement("button");
  genBtn.className = "btn btn-primary";
  genBtn.textContent = "Generate";
  const genMetric = document.createElement("select");
  genMetric.className = "input detail-metric";
  genMetric.innerHTML = `<option value="revenue">Revenue</option><option value="units">Units</option>`;
  genMetric.setAttribute("aria-label", "Measure to chart");
  genBar.appendChild(genMetric);
  genBar.appendChild(genBtn);
  productTrend.body.appendChild(genBar);
  const genOut = document.createElement("div");
  productTrend.body.appendChild(genOut);

  let range = { from: null, to: null, bucket: "day", label: "Lifetime" };

  function busy(el) {
    el.innerHTML = `<div class="chart-empty">Loading…</div>`;
  }
  function failed(el, msg) {
    // Never a bare "error". Say what failed and what to do.
    el.innerHTML = `<div class="chart-empty chart-error">${esc(msg)}</div>`;
  }

  async function load() {
    tiles.innerHTML = `<div class="card stat-card"><div class="stat-label">Loading</div><div class="stat-value">…</div></div>`;
    busy(trend.body); busy(products.body); busy(clients.body);
    genOut.innerHTML = "";

    const [sum, top, series, clientRows, topClients] = await Promise.all([
      getWholesalerSummary(wid, range),
      getTopProducts(wid, { ...range, limit: 8 }),
      getSalesSeries(wid, { ...range, bucket: range.bucket }),
      getClientList(wid, range),
      getTopClients(wid, { ...range, limit: 3 }),
    ]);

    // ---- tiles -----------------------------------------------------------
    if (!sum.ok) {
      tiles.innerHTML = `<div class="card stat-card"><div class="stat-label">Could not load</div>
        <div class="stat-value">—</div><div class="stat-note">${esc(sum.error)}</div></div>`;
    } else {
      tiles.innerHTML = [
        statTile("Orders", String(sum.orders),
          sum.cancelled ? `${sum.cancelled} cancelled (${sum.cancellationRate}%)` : "none cancelled"),
        statTile("Revenue", money(sum.revenue, currency),
          `${sum.units.toLocaleString()} units`),
        // AOV and median together, on purpose: they disagree when one big
        // order distorts the average, and the gap is the useful signal.
        statTile("Average order", money(sum.avgOrder, currency),
          `median ${money(sum.medianOrder, currency)}`),
        statTile("Customers", String(sum.clientsTotal),
          `${sum.clientsOrdered} ordered · ${sum.clientsNever} never`),
        statTile("Products", String(sum.productsTotal),
          `${sum.productsSold} sold in this period`),
        statTile("Last order", when(sum.lastOrderAt),
          sum.firstOrderAt ? `first ${when(sum.firstOrderAt)}` : "no orders yet"),
        // Highest-paying customer, asked for by name. Concentration is shown
        // beside it because one client at a large share of a wholesaler's
        // revenue is a risk signal, and it is invisible without the percentage.
        (() => {
          const best = (topClients.rows || []).find((c) => c.revenue > 0);
          if (!best) return statTile("Top customer", "—", "no client has ordered yet");
          return statTile("Top customer", best.shopName || "—",
            `${money(best.revenue, currency)} · ${best.pctOfRevenue}% of their revenue`);
        })(),
      ].join("");
    }

    // ---- sales over time -------------------------------------------------
    trend.body.innerHTML = "";
    if (!series.ok) failed(trend.body, series.error);
    else if (!series.rows.length) {
      trend.body.innerHTML = `<div class="chart-empty">No orders in this period.</div>`;
    } else {
      trend.body.appendChild(renderLineChart({
        buckets: series.rows.map((r) => r.at),
        series: [{ name: "Revenue", points: series.rows.map((r) => r.revenue) }],
        currency,
      }));
    }

    // ---- top products ----------------------------------------------------
    products.body.innerHTML = "";
    if (!top.ok) failed(products.body, top.error);
    else if (!top.rows.length) {
      products.body.innerHTML = `<div class="chart-empty">Nothing sold in this period.</div>`;
    } else {
      products.body.appendChild(renderBarChart({
        currency,
        rows: top.rows.map((r) => ({
          label: r.name, value: r.revenue,
          detail: [["Units", r.units.toLocaleString()],
                   ["Orders", String(r.orders)],
                   ["Share of revenue", `${r.pctOfRevenue}%`]],
        })),
      }));
    }

    // ---- clients ---------------------------------------------------------
    clients.body.innerHTML = "";
    if (!clientRows.ok) failed(clients.body, clientRows.error);
    else if (!clientRows.rows.length) {
      clients.body.innerHTML = `<div class="chart-empty">This wholesaler has no clients yet.</div>`;
    } else {
      const t = document.createElement("div");
      t.className = "table-wrap";
      t.innerHTML = `<table class="data-table">
        <thead><tr>
          <th>Shop</th><th class="num">Orders</th><th class="num">Spent</th>
          <th class="num">Units</th><th>Last order</th><th class="num">Discount</th>
        </tr></thead><tbody>${
          clientRows.rows.map((c) => `<tr${c.active ? "" : ' class="is-inactive"'}>
            <td>${esc(c.shopName || "—")}${c.active ? "" : ' <span class="badge badge-neutral">inactive</span>'}
              ${c.phone ? `<div class="cell-sub">${esc(c.phone)}</div>` : ""}</td>
            <td class="num">${c.orders}</td>
            <td class="num">${esc(money(c.revenue, currency))}</td>
            <td class="num">${c.units.toLocaleString()}</td>
            <td>${esc(when(c.lastOrderAt))}</td>
            <td class="num">${c.discountPct ? c.discountPct + "%" : "—"}</td>
          </tr>`).join("")
        }</tbody></table>`;
      clients.body.appendChild(t);

      const never = clientRows.rows.filter((c) => !c.orders).length;
      if (never) {
        const n = document.createElement("p");
        n.className = "detail-note";
        // The actionable read, spelled out rather than left as arithmetic.
        n.textContent = `${never} of ${clientRows.rows.length} have never ordered in this period — those are the ones worth a call.`;
        clients.body.appendChild(n);
      }
    }
  }

  // ---- the Generate button ------------------------------------------------
  genBtn.addEventListener("click", async () => {
    genBtn.disabled = true;
    genBtn.textContent = "Generating…";
    genOut.innerHTML = `<div class="chart-empty">Loading…</div>`;

    const metric = genMetric.value;
    const res = await getProductSeries(wid, { ...range, bucket: range.bucket, metric });

    genBtn.disabled = false;
    genBtn.textContent = "Generate";
    genOut.innerHTML = "";

    if (!res.ok) { failed(genOut, res.error); return; }
    if (!res.series.length) {
      genOut.innerHTML = `<div class="chart-empty">Nothing sold in this period, so there is nothing to plot.</div>`;
      return;
    }

    // The palette holds six. A seventh series would mean either a cycled
    // colour (two products the same) or an invented hue -- both are banned.
    // Everything past six folds into one honest "Other" line.
    const TOP = 6;
    const shown = res.series.slice(0, TOP);
    if (res.series.length > TOP) {
      const rest = res.series.slice(TOP);
      shown.push({
        name: `Other (${rest.length} products)`,
        points: res.buckets.map((_, i) => rest.reduce((s, r) => s + (r.points[i] || 0), 0)),
      });
    }
    genOut.appendChild(renderLineChart({
      buckets: res.buckets, series: shown, currency,
      valueFormat: metric === "units" ? "number" : "money",
    }));
    if (res.series.length > TOP) {
      const n = document.createElement("p");
      n.className = "detail-note";
      // Never a silent cap. Say what was folded away.
      n.textContent = `Showing the top ${TOP} of ${res.series.length} products; the rest are combined into "Other".`;
      genOut.appendChild(n);
    }
    toast(`Charted ${res.series.length} product${res.series.length === 1 ? "" : "s"}`, { type: "success" });
  });

  // ---- mount the filter last, so its first fire triggers the load ---------
  const filter = renderDateRangeFilter({
    initial: "30d",
    onChange: (v) => { range = v; load(); },
  });
  filterWrap.appendChild(filter.el);
  filter.trigger();
}

/**
 * Registers /owner/wholesaler.
 *
 * The router here is hash-based with no path-parameter support, so the wid
 * rides as a query string: #/owner/wholesaler?wid=mg
 * Chosen over adding parameter parsing to the router because that is a change
 * to shared routing used by every role, and this screen does not justify it.
 */
export function registerWholesalerDetailRoute(router) {
  router.register("/owner/wholesaler", async (outlet) => {
    const q = window.location.hash.split("?")[1] || "";
    const wid = new URLSearchParams(q).get("wid");
    if (!wid) { await wholesalerDetailView(outlet, null); return; }

    // Fetched here rather than passed in, so the screen survives a hard
    // refresh or a pasted link -- the two ways an operator actually arrives
    // at a URL like this.
    const { data } = await sbCall(
      supabase.from("v2_wholesalers").select("wid, brand, name, currency, active").eq("wid", wid).maybeSingle()
    );
    await wholesalerDetailView(outlet, data
      ? { wid: data.wid, brand: data.brand || data.name, currency: data.currency || "$", active: data.active }
      : { wid });
  });
}
