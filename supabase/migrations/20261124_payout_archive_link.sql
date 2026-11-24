-- ============================================================
-- Auszahlungsliste: "ohne Lokal" bei archivierten Events beheben
-- ------------------------------------------------------------
-- Ursache: Stripe-Buchungen werden erst beim Payout (payout.paid) importiert
-- bzw. einer Bestellung zugeordnet. Wurde das Event vorher archiviert, ist
-- orders.event_id bereits NULL und archive_freeze_finance() hat diese
-- Buchungen nicht erfasst (sie existierten beim Archivieren noch nicht).
-- -> weder Event noch Archiv bekannt -> Lokal leer -> "ohne Lokal".
--
-- Lösung:
-- 1) Funktion, die für eine Bestellung ohne Event den passenden Archiv-
--    eintrag findet (gleicher Eventname UND gleiches Eventdatum, eindeutig).
-- 2) Trigger: sobald eine Buchung einer Bestellung zugeordnet wird und kein
--    Archiv gesetzt ist, wird es automatisch nachgetragen.
-- 3) Einmaliger Nachtrag für alle bestehenden Buchungen.
-- ============================================================
begin;

create or replace function public.archive_for_order(p_order text) returns uuid
language sql stable security definer set search_path to 'public' as $$
  with o as (
    select (select min(i.event_name) from order_items i where i.order_id = p_order) as en,
           (select (min(t.event_date) at time zone 'Europe/Vienna')::date from tickets t where t.order_id = p_order) as ed
  ), m as (
    select a.id from event_archive a, o
     where a.name = o.en and a.event_date = o.ed
  )
  select case when (select count(*) from m) = 1 then (select id from m) end;
$$;
revoke all on function public.archive_for_order(text) from public, anon, authenticated;

create or replace function public.balance_txn_link_archive() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.order_id is not null and new.archive_id is null
     and exists (select 1 from orders o where o.id = new.order_id and o.event_id is null) then
    new.archive_id := archive_for_order(new.order_id);
  end if;
  return new;
end $$;

drop trigger if exists balance_txn_link_archive on public.stripe_balance_txns;
create trigger balance_txn_link_archive
  before insert or update of order_id, archive_id on public.stripe_balance_txns
  for each row execute function public.balance_txn_link_archive();

-- Einmaliger Nachtrag
update public.stripe_balance_txns b
   set archive_id = public.archive_for_order(b.order_id)
 where b.archive_id is null and b.order_id is not null
   and exists (select 1 from orders o where o.id = b.order_id and o.event_id is null)
   and public.archive_for_order(b.order_id) is not null;

commit;
