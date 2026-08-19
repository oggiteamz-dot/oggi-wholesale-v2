-- OGGI Wholesale v2 — Batch 18: a supplier record you could actually work from
--
-- Hadi: "add one more and that is categories, or basically what does this
-- supplier sell... I'm going to be using this information to actually contact
-- these suppliers in the future. Imagine that the supplier is a wholesaler as
-- well, meaning I want all the information that they might also have. What
-- brands do they hold? What category do they sell?"
--
-- Batch 17 shipped the minimum he asked for then, and he was right that it was
-- too thin: name and a phone number is a contact card, not a sourcing record.
-- What a buyer needs before placing an order is what they sell, whose brands
-- they carry, what it costs in money and time to order, and how to reach them
-- on the channel they actually answer.
--
-- Required stays exactly four -- name, contact person, phone, location -- per
-- "make everything optional to add except the name and location and phone
-- number and person of contact". That rule is enforced in the app rather than
-- with NOT NULL columns, so the suppliers created under Batch 17 stay valid
-- and editable instead of becoming rows that can be read but never saved.

set search_path = wholesale_v2, public;

alter table wholesale_v2.v2_suppliers
  add column if not exists sells        text[] not null default '{}',
  add column if not exists brands       text[] not null default '{}',
  add column if not exists moq          text,
  add column if not exists lead_time    text,
  add column if not exists payment_terms text,
  add column if not exists currency     text,
  add column if not exists website      text,
  add column if not exists whatsapp     text,
  add column if not exists instagram    text,
  add column if not exists catalog_url  text,
  add column if not exists rating       int,
  add column if not exists status       text not null default 'active',
  add column if not exists last_contacted date;

alter table wholesale_v2.v2_suppliers drop constraint if exists v2_suppliers_rating_ck;
alter table wholesale_v2.v2_suppliers
  add constraint v2_suppliers_rating_ck check (rating is null or rating between 1 and 5);

alter table wholesale_v2.v2_suppliers drop constraint if exists v2_suppliers_status_ck;
alter table wholesale_v2.v2_suppliers
  add constraint v2_suppliers_status_ck check (status in ('active','trialling','dropped'));

comment on column wholesale_v2.v2_suppliers.sells is
  'What this supplier actually sells -- categories/product types. A text[] rather than a join to v2_categories on purpose: a supplier''s own range is their vocabulary, not this wholesaler''s taxonomy, and forcing it into the local category list would either lose detail or pollute the catalogue''s categories with words no buyer should ever see.';

comment on column wholesale_v2.v2_suppliers.status is
  'active | trialling | dropped. Kept separate from `archived`: dropped is a judgement about the relationship that stays visible and searchable, archived is "stop showing me this at all". Conflating them loses the ability to answer "who did we stop using, and why".';

-- lead_time, moq and payment_terms are TEXT and not numbers by design. Real
-- answers are "3-4 weeks after sampling", "500 pcs per colourway" and "30%
-- deposit, balance on BL". An integer column would make the field a lie in
-- most cases; the value here is reading it back before placing an order, not
-- computing with it. If a later batch needs arithmetic it can add a parsed
-- column beside these rather than destroying what people actually typed.

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='wholesale_v2' and table_name='v2_suppliers' and column_name='sells') then
    raise exception 'v2_suppliers.sells was not created.';
  end if;
end $$;
