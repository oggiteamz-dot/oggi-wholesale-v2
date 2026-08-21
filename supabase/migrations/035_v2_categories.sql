-- OGGI Wholesale v2 — Migration 035: categories a wholesaler sells in
-- 17 Aug 2026 · CR-0001 R2
--
-- WHY A TABLE AND NOT A HARD-CODED LIST:
-- Hadi asked for preset categories he can click, AND the ability to type
-- a new one. If the presets lived in a JavaScript array, adding
-- "Swimwear" would mean a code change, a deploy, and a session with me --
-- for what is a piece of business vocabulary. As a table, he adds it
-- himself and it is instantly available to every wholesaler.
--
-- WHY A JOIN TABLE:
-- A wholesaler sells across several categories at once ("a wholesaler can
-- have multiple different categories that they sell" -- his words). One
-- column could not hold that.
--
-- ---------------------------------------------------------------------
-- RECOVERED 21 Aug 2026 (Batch 7). This migration was applied to the
-- database on 17 Aug and the FILE WAS NEVER COMMITTED, along with 036 and
-- 038. FEATURE-MANIFEST.md had already recorded the same class of drift
-- for 028/030/031/032 and asked for a back-fill; that back-fill happened
-- and these three were missed, so the repo still could not rebuild the
-- database and nothing said so. The text below is the exact SQL the
-- database recorded in supabase_migrations.schema_migrations, not a
-- reconstruction from memory.
-- ---------------------------------------------------------------------

create table if not exists wholesale_v2.v2_categories (
  id         uuid primary key default gen_random_uuid(),
  -- Stored as typed. Uniqueness is enforced case-insensitively by the
  -- index below so "Menswear" and "menswear" cannot both exist.
  name       text not null,
  -- Lets the owner order the preset chips so the ones he uses most sit
  -- first, instead of alphabetical-forever.
  sort_order int  not null default 100,
  -- Retire a category without deleting it: existing wholesalers keep
  -- their link and their history, it just stops appearing as a preset.
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists v2_categories_name_ci
  on wholesale_v2.v2_categories (lower(name));

-- The many-to-many link. ON DELETE CASCADE on wid means removing a
-- wholesaler cleans up its category links; RESTRICT on the category means
-- a category still in use cannot be deleted out from under a wholesaler.
create table if not exists wholesale_v2.v2_wholesaler_categories (
  wid         text not null references wholesale_v2.v2_wholesalers(wid) on delete cascade,
  category_id uuid not null references wholesale_v2.v2_categories(id)   on delete restrict,
  primary key (wid, category_id)
);

create index if not exists v2_wholesaler_categories_by_category
  on wholesale_v2.v2_wholesaler_categories (category_id);

alter table wholesale_v2.v2_categories            enable row level security;
alter table wholesale_v2.v2_wholesaler_categories enable row level security;

-- Readable by anyone signed in (the buyer-facing supplier directory will
-- want to show "what do they sell"); writable only by an owner. Uses the
-- v2_is_owner() helper that already guards v2_create_invite, so there is
-- one definition of "is this person the owner", not two.
drop policy if exists v2_categories_read on wholesale_v2.v2_categories;
create policy v2_categories_read on wholesale_v2.v2_categories
  for select using (true);

drop policy if exists v2_categories_write on wholesale_v2.v2_categories;
create policy v2_categories_write on wholesale_v2.v2_categories
  for all using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

drop policy if exists v2_wholesaler_categories_read on wholesale_v2.v2_wholesaler_categories;
create policy v2_wholesaler_categories_read on wholesale_v2.v2_wholesaler_categories
  for select using (true);

drop policy if exists v2_wholesaler_categories_write on wholesale_v2.v2_wholesaler_categories;
create policy v2_wholesaler_categories_write on wholesale_v2.v2_wholesaler_categories
  for all using (wholesale_v2.v2_is_owner()) with check (wholesale_v2.v2_is_owner());

grant select on wholesale_v2.v2_categories,            wholesale_v2.v2_wholesaler_categories to anon, authenticated;
grant insert, update, delete on wholesale_v2.v2_categories,            wholesale_v2.v2_wholesaler_categories to authenticated;

-- Starter presets for an apparel/fashion wholesale market. These are a
-- STARTING POINT, not a fixed list -- Hadi edits, reorders, retires and
-- adds to them from the owner console without touching this file.
insert into wholesale_v2.v2_categories (name, sort_order) values
  ('Womenswear', 10), ('Menswear', 20), ('Kidswear', 30), ('Babywear', 40),
  ('Shoes', 50), ('Bags', 60), ('Accessories', 70), ('Jewellery', 80),
  ('Lingerie & Nightwear', 90), ('Sportswear & Activewear', 100),
  ('Denim', 110), ('Outerwear & Jackets', 120), ('Knitwear', 130),
  ('Swimwear', 140), ('Modest Wear & Abaya', 150), ('Workwear & Uniforms', 160),
  ('Fabrics & Textiles', 170), ('Home Textiles & Linen', 180),
  ('Scarves & Shawls', 190), ('Socks & Hosiery', 200)
on conflict do nothing;
