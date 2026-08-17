// OGGI Wholesale v2 — the categories a wholesaler sells in (CR-0001 R2)
//
// WHY CATEGORIES ARE A TABLE AND NOT A LIST IN THIS FILE
// It would have been quicker to write
//     const CATEGORIES = ["Womenswear", "Menswear", ...]
// right here. Don't. The moment Hadi wants to add "Swimwear" that becomes
// a code change, a deploy, and a conversation with a developer -- for a
// piece of business vocabulary he should own outright. They live in the
// `v2_categories` table instead, seeded with 20 starters in migration
// 035, and he adds/reorders/retires them himself.
//
// A wholesaler has MANY categories ("a wholesaler can have multiple
// different categories that they sell"), which is why the link lives in
// its own `v2_wholesaler_categories` table rather than a column.

import { supabase, sbCall } from "../lib/supabase-client.js";

/**
 * The preset categories, in the owner's chosen order, for the picker chips.
 * Retired ones (active = false) are excluded: they stay attached to any
 * wholesaler already using them, they just stop being offered.
 */
export async function listCategories() {
  const { data } = await sbCall(
    supabase.from("v2_categories").select("id, name, sort_order")
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true })
  );
  return data || [];
}

/**
 * The categories one wholesaler sells in. Used by the detail page and to
 * pre-tick the picker when editing.
 */
export async function getCategoriesFor(wid) {
  const { data } = await sbCall(
    supabase.from("v2_wholesaler_categories").select("category_id, v2_categories(id, name)").eq("wid", wid)
  );
  return (data || []).map((r) => r.v2_categories).filter(Boolean);
}

/**
 * Adds a brand-new category to the preset list.
 *
 * NOTE: creating a wholesaler does NOT need this -- `createWholesaler`
 * passes category NAMES and the database creates any it doesn't
 * recognise, inside the same transaction. This is for managing the preset
 * list on its own, away from the create form.
 *
 * Uniqueness is case-insensitive in the database, so "Denim" and "denim"
 * cannot both exist; a duplicate comes back as an error rather than
 * quietly making a second one.
 */
export async function createCategory(name, sortOrder = 100) {
  const clean = (name || "").trim();
  if (!clean) return { ok: false, error: "Category name cannot be empty" };

  const { data, error } = await sbCall(
    supabase.from("v2_categories").insert({ name: clean, sort_order: sortOrder }).select().single()
  );
  if (error) {
    // 23505 = unique violation. Say the useful thing, not the Postgres thing.
    if (error.code === "23505") return { ok: false, error: `"${clean}" already exists` };
    return { ok: false, error: error.message || "Could not add that category" };
  }
  return { ok: true, error: "", category: data };
}

/**
 * Retires a category. Deliberately NOT a delete: the database refuses to
 * delete one that a wholesaler is still linked to (on delete restrict),
 * because that would rewrite history. Hiding it is almost always what is
 * actually meant.
 */
export async function retireCategory(categoryId) {
  return sbCall(supabase.from("v2_categories").update({ active: false }).eq("id", categoryId));
}
