-- ============================================================
-- Focus Events / CORE – Kundenname auf Bestellungen
-- ------------------------------------------------------------
-- Speichert den Namen des/der Bestellenden je Bestellung, damit er
-- im Dashboard sichtbar und durchsuchbar ist. Wird beim Checkout aus
-- dem angemeldeten Profil (user_metadata.full_name) übernommen bzw.
-- beim manuellen Ausstellen optional mitgegeben. Additiv/nicht brechend.
-- ============================================================
begin;

alter table public.orders add column if not exists customer_name text;
create index if not exists orders_customer_name_idx on public.orders (lower(customer_name));

notify pgrst, 'reload schema';
commit;
