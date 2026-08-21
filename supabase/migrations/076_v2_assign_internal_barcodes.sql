-- =====================================================================
-- 076 — Give variants a barcode the app can actually read (Batch 4, L1)
--
-- v1 generated printable barcodes per variant. v2 can only DECODE them:
-- js/lib/barcode-decode.js reads EAN-13, UPC-A and EAN-8 from the camera,
-- and there has never been anything to produce one. Measured on
-- production: 0 of 191 variants carry a barcode. The scanner has nothing
-- to scan.
--
-- WHY EAN-13 AND NOT CODE 128, WHICH IS WHAT v1 USED
-- ---------------------------------------------------------------------
-- Copying v1 exactly would have been the wrong move here, and it is
-- worth writing down why.
--
-- v1 printed Code 128-B. v1 also had no camera decoder, so nothing in v1
-- ever had to read its own labels. v2 does have one, and it decodes
-- EAN-13 / UPC-A / EAN-8 -- explicitly NOT Code 128 (see the header of
-- barcode-decode.js, which says so and explains that a half-working
-- Code 128 reader would be worse than an honest refusal).
--
-- So printing Code 128 would have produced labels that this app's own
-- scanner cannot read. Generate -> print -> scan -> resolve is the whole
-- point of the feature, and that loop would not have closed. The tell
-- would have been a wholesaler standing in a warehouse pointing a phone
-- at a label the same phone had printed an hour earlier.
--
-- EAN-13 prefixes 20-29 are reserved by GS1 for "restricted circulation
-- within a company" -- in-store codes, exactly this use. So an internal
-- barcode here is a real, well-formed EAN-13 that:
--   * this app's existing decoder reads with no new code,
--   * any hardware scanner reads,
--   * and is guaranteed never to collide with a manufacturer's GTIN,
--     because that range is set aside for it.
--
-- WHY ASSIGNMENT IS SERVER-SIDE
-- ---------------------------------------------------------------------
-- v2_product_variants.barcode carries a UNIQUE index. Generating numbers
-- in the browser means two people assigning at once produce a collision,
-- and the retry logic to survive that belongs nowhere near a UI. Here it
-- is a single statement against the current maximum.
--
-- It NEVER overwrites an existing barcode. A variant that already
-- carries a manufacturer's GTIN keeps it -- that code is a fact about
-- the goods, not a field for us to reuse.
-- =====================================================================

create or replace function wholesale_v2.v2_ean13_check_digit(p_first12 text)
returns int
language plpgsql
immutable
as $fn$
declare
  s int := 0;
  i int;
  d int;
begin
  if p_first12 !~ '^[0-9]{12}$' then
    raise exception 'v2_ean13_check_digit expects exactly 12 digits, got %', p_first12;
  end if;
  -- Weights alternate 3/1 counting from the RIGHT. Getting that backwards
  -- produces a checksum that is correct half the time, which is the worst
  -- possible behaviour for a checksum -- it passes just often enough to be
  -- trusted. barcode-decode.js reverses for the same reason and says so.
  for i in 1..12 loop
    d := substr(p_first12, 13 - i, 1)::int;
    s := s + d * (case when i % 2 = 1 then 3 else 1 end);
  end loop;
  return (10 - (s % 10)) % 10;
end;
$fn$;

comment on function wholesale_v2.v2_ean13_check_digit(text) is
  'Migration 076. EAN-13 check digit. The exact inverse of checkDigitOk() in '
  'js/lib/barcode-decode.js, so a code minted here is one this app''s own '
  'camera scanner accepts.';

create or replace function wholesale_v2.v2_assign_internal_barcodes(
  p_product_id uuid default null,
  p_wid        text default null
)
returns table (variant_id uuid, sku text, barcode text)
language plpgsql
security definer
set search_path = wholesale_v2, public
as $fn$
declare
  v_wid  text;
  v_next bigint;
begin
  v_wid := case
             when wholesale_v2.v2_is_owner() and p_wid is not null then p_wid
             else wholesale_v2.v2_my_wid()
           end;
  if v_wid is null then
    return;
  end if;

  -- The next free internal serial, taken across the WHOLE table rather than
  -- per wholesaler: the unique index is global, so the counter must be too.
  select coalesce(max(substring(b.barcode from 3 for 10)::bigint), 0) + 1
    into v_next
    from v2_product_variants b
   where b.barcode ~ '^2[0-9][0-9]{10}[0-9]$';

  return query
  with target as (
    select v.id, v.sku,
           row_number() over (order by v.sku) - 1 as n
      from v2_product_variants v
      join v2_products p on p.id = v.product_id
     where p.wid = v_wid
       and v.archived = false
       and p.archived = false
       -- Never overwrite. An existing code is a fact about the goods.
       and (v.barcode is null or v.barcode = '')
       and (p_product_id is null or p.id = p_product_id)
  ),
  minted as (
    select t.id, t.sku,
           ('20' || lpad((v_next + t.n)::text, 10, '0')) as first12
      from target t
  ),
  final as (
    select m.id, m.sku,
           m.first12 || wholesale_v2.v2_ean13_check_digit(m.first12)::text as code
      from minted m
  ),
  upd as (
    update v2_product_variants v
       set barcode = f.code, updated_at = now()
      from final f
     where v.id = f.id
     returning v.id, v.sku, v.barcode
  )
  select upd.id, upd.sku, upd.barcode from upd order by upd.sku;
end;
$fn$;

revoke execute on function wholesale_v2.v2_assign_internal_barcodes(uuid,text) from public;
revoke execute on function wholesale_v2.v2_assign_internal_barcodes(uuid,text) from anon;
grant  execute on function wholesale_v2.v2_assign_internal_barcodes(uuid,text) to authenticated;

comment on function wholesale_v2.v2_assign_internal_barcodes(uuid,text) is
  'Migration 076. Batch 4. Mints EAN-13 codes in the GS1 restricted-circulation '
  'range (prefix 20-29) for variants that have none, scoped to the caller''s '
  'wholesaler. Never overwrites an existing barcode. EAN-13 rather than v1''s '
  'Code 128 because this app''s own camera decoder reads EAN-13 and explicitly '
  'does not read Code 128 -- printing Code 128 would produce labels the app '
  'that printed them could not scan.';
