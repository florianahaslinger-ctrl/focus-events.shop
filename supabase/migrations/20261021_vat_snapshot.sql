-- ============================================================
-- Focus Events – Umsatzsteuer fest an jeder Bestellung
-- ------------------------------------------------------------
-- Bisher wurde der MwSt-Satz erst beim Auswerten vom Event gelesen. Wird
-- der Satz eines Events spaeter geaendert (13 % -> 20 %), aendern sich
-- rueckwirkend alle Auswertungen und bereits verbuchte Auszahlungen.
--
-- Neu: orders.vat_rate haelt den Satz zum Zeitpunkt des Kaufs fest.
--   * beim Anlegen der Bestellung automatisch aus dem Event (Trigger)
--   * fehlte der Satz beim Kauf und wird er am Event nachgetragen,
--     erhalten die betroffenen Bestellungen ihn nachtraeglich
--   * spaetere Aenderungen am Event aendern bestehende Bestellungen NICHT
-- payout_itemization() verwendet den festgehaltenen Satz.
-- ============================================================
begin;

alter table public.orders add column if not exists vat_rate numeric(5,2);

create or replace function public.order_vat_snapshot()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.vat_rate is null and new.event_id is not null then
    select e.vat_rate into new.vat_rate from events e where e.id = new.event_id;
  end if;
  return new;
end $$;
drop trigger if exists order_vat_snapshot on public.orders;
create trigger order_vat_snapshot before insert or update of event_id on public.orders
  for each row execute function public.order_vat_snapshot();

create or replace function public.event_vat_backfill()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  if old.vat_rate is null and new.vat_rate is not null then
    update orders set vat_rate = new.vat_rate where event_id = new.id and vat_rate is null;
  end if;
  return new;
end $$;
drop trigger if exists event_vat_backfill on public.events;
create trigger event_vat_backfill after update of vat_rate on public.events
  for each row execute function public.event_vat_backfill();

-- Bestand: Satz aus dem Event bzw. bei geloeschten Events aus dem Archiv
update public.orders o set vat_rate = e.vat_rate
  from public.events e where e.id = o.event_id and o.vat_rate is null and e.vat_rate is not null;

update public.orders o set vat_rate = a.vat_rate
  from public.stripe_balance_txns b join public.event_archive a on a.id = b.archive_id
 where b.order_id = o.id and o.vat_rate is null and a.vat_rate is not null;

update public.orders o set vat_rate = a.vat_rate
  from public.event_archive a
 where o.vat_rate is null and o.event_id is null and a.vat_rate is not null
   and exists (select 1 from public.order_items i where i.order_id = o.id and i.event_name = a.name);

-- Auszahlungsbeleg: festgehaltener Satz der Bestellung hat Vorrang
create or replace function public.payout_itemization(p_storefront text)
returns table(
  payout_id text, payout_at timestamptz, paid_at timestamptz, balance_transaction_id text,
  order_id text, kostenstelle text, club text, event_date date, artikel text, tickets int,
  ticket_revenue numeric, vat_rate numeric, gross numeric, service_fee numeric,
  payment_fee numeric, fee numeric, net numeric)
language sql stable security definer set search_path to 'public'
as $$
  select b.payout_id, b.payout_at, b.created_at, b.balance_transaction_id, b.order_id,
         coalesce(ar.name, ev.name, (select min(i.event_name) from order_items i where i.order_id = o.id), 'ohne Event'),
         coalesce(ar.club, ev.club),
         coalesce(ar.event_date, (ev.date at time zone 'Europe/Vienna')::date,
                  (select (min(t.event_date) at time zone 'Europe/Vienna')::date from tickets t where t.order_id = o.id)),
         (select string_agg(i.qty || '× ' || i.category_name, ', ' order by i.category_name)
            from order_items i where i.order_id = o.id),
         (select count(*)::int from tickets t where t.order_id = o.id),
         case when o.id is not null then o.subtotal else b.gross end,
         coalesce(o.vat_rate, ev.vat_rate, ar.vat_rate),
         b.gross, b.service_fee, b.payment_fee, b.fee, b.net
    from stripe_balance_txns b
    left join orders o on o.id = b.order_id
    left join events ev on ev.id = o.event_id
    left join event_archive ar on ar.id = b.archive_id
   where b.connected_account in (select storefront_stripe_accounts(p_storefront))
     and b.reporting_category = 'charge'
   order by b.payout_at nulls first, b.created_at;
$$;

notify pgrst, 'reload schema';
commit;
