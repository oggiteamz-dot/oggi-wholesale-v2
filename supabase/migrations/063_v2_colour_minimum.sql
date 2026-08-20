-- =====================================================================
-- 063 — "Minimum 12 per colour", enforced by the server
--
-- Hadi, 20 Aug 2026: "let's say they picked the colours red and blue,
-- and they chose five different sizes. But the thing is, let's say it's
-- a bare minimum per colour to be, you know, 12 per pack."
--
-- Asked which of two readings he meant, he answered: BOTH, chosen per
-- product. That turns out to need almost nothing new, because the
-- product already carries the switch:
--
--   selling_model = 'ratio' / 'prepack' / 'series'
--        -> the wholesaler's curve decides the size mix. Migration 030
--           already refuses loose lines on these. Reading A. Done.
--
--   selling_model = 'open'
--        -> the shop picks its own sizes. Reading B. Nothing stopped
--           them taking 5 of one colour. THAT is the gap this closes.
--
-- So this migration adds one column and one rule, rather than a general
-- rules engine nobody asked for.
--
-- WHY COLOUR, WHEN THREE MINIMUMS ALREADY EXIST
-- ---------------------------------------------------------------------
-- v2_submit_order already enforces three, and they are all real:
--   * per SKU      -- v2_product_variants.moq_qty
--   * per product  -- v2_products.moq_qty (+ moq_reorder_qty)
--   * per order    -- v2_wholesalers.order_min_qty / order_min_value
--
-- None of them can express "12 of each colour". A per-product minimum of
-- 12 is satisfied by 12 units of a single colour; a per-SKU minimum
-- applies to one size, not a colourway. Colour is a genuinely different
-- axis and the trade uses it: the documented practice is "12 pieces per
-- style PER COLOUR -- three colours means 36 pieces, not 12".
--
-- ⚠️ HONEST NOTE, RECORDED SO NOBODY LATER THINKS THIS WAS COPIED:
-- colour-scoped minimums were NOT found in any shipped B2B platform
-- researched (Shopify B2B explicitly cannot do it -- its own docs say
-- "customers can't combine 5 gray hats and 5 blue hats to meet an
-- increment of 10"). This is ahead of the software market, not behind
-- it, and it is here because a real wholesaler asked for it.
--
-- WHERE THE RULE LIVES, AND WHY NOT IN v2_submit_order
-- ---------------------------------------------------------------------
-- v2_enforce_selling_model is already called once per product inside the
-- order transaction, and tmp_order_lines -- a temp table in the same
-- session -- is readable from it. Extending that small function keeps
-- the change to ~20 lines instead of re-issuing the whole 300-line
-- v2_submit_order, which is the kind of edit that loses a rule by
-- accident. Every existing rule in that function is untouched.
-- =====================================================================

set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_products
  add column if not exists moq_per_colour integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'v2_products_moq_per_colour_sane') then
    alter table wholesale_v2.v2_products
      add constraint v2_products_moq_per_colour_sane
      check (moq_per_colour is null or moq_per_colour >= 1);
  end if;
end $$;

comment on column wholesale_v2.v2_products.moq_per_colour is
  'Minimum units of EACH colour ordered, counted across all sizes of that colour. NULL = no colour rule. Distinct from moq_qty (per product, which 12 units of one colour would satisfy) and from variant moq_qty (per size). Hadi, 20 Aug 2026: "a bare minimum per colour to be 12 per pack."';

-- ---------------------------------------------------------------------
-- The rule, added to the function that already runs per product
-- ---------------------------------------------------------------------
-- The three existing selling-model rules are reproduced EXACTLY as
-- migration 030 wrote them. This function is replaced, not extended in
-- place, so they have to be here -- and if any wording below has drifted
-- from 030, that is a bug, not an improvement.
create or replace function wholesale_v2.v2_enforce_selling_model(
  p_product_id uuid, p_has_pack_line boolean, p_product_name text
) returns void
language plpgsql
set search_path = wholesale_v2
as $$
declare
  v_model text;
  v_min   integer;
  v_bad   record;
begin
  select selling_model, moq_per_colour into v_model, v_min
    from v2_products where id = p_product_id;

  -- ---- migration 029/030 rules, unchanged ----
  if v_model = 'series' and not p_has_pack_line then
    raise exception
      '"%" is sold as a full series -- every colour and size together. Add it as a series rather than as individual sizes.',
      p_product_name;
  end if;

  if v_model = 'prepack' and not p_has_pack_line then
    raise exception
      '"%" is sold in fixed cartons. Choose a colour and a number of cartons rather than individual sizes.',
      p_product_name;
  end if;

  if v_model = 'ratio' and not p_has_pack_line then
    raise exception
      '"%" is sold in ratio packs -- the size mix is set by the wholesaler. Choose a colour and a number of packs rather than individual sizes.',
      p_product_name;
  end if;

  -- ---- migration 063: minimum per colour ----
  --
  -- Guarded on the temp table existing so this function stays callable
  -- from anywhere. Outside an order there are no lines to judge, and
  -- silently passing is correct -- there is nothing to refuse.
  if v_min is not null
     and to_regclass('pg_temp.tmp_order_lines') is not null then

    -- Sizes of the same colour are SUMMED. "12 red" means twelve red
    -- garments in any mix of sizes, not twelve of each size -- that is
    -- what the wholesaler means when they say it out loud, and getting
    -- this backwards would make a 4-size product demand 48.
    for v_bad in
      select coalesce(pv.extra_attrs->>'color', '(no colour)') as colour,
             sum(tol.qty)::int as got
        from tmp_order_lines tol
        join v2_product_variants pv on pv.id = tol.variant_id
       where tol.product_id = p_product_id
       group by 1
      having sum(tol.qty) < v_min
    loop
      -- The message says the colour, the number required and the number
      -- actually there. A refusal that does not say how far short you
      -- are is a refusal you have to guess your way past.
      raise exception
        '"%" needs at least % of each colour. % has only %.',
        p_product_name, v_min, v_bad.colour, v_bad.got;
    end loop;
  end if;
end;
$$;

comment on function wholesale_v2.v2_enforce_selling_model(uuid, boolean, text) is
  'Per-product order rules, run inside the order transaction: the 029/030 selling-model rules (series/prepack/ratio cannot be bought as loose sizes) plus, from migration 063, the minimum-per-colour rule. Reads tmp_order_lines for the colour totals, guarded so it stays safe to call outside an order.';
