-- ============================================================
-- Focus Events – Stripe-Buchungen vollstaendig zuordnen
-- ------------------------------------------------------------
-- Problem: Die Auszahlungsuebersicht (Stripe-Buchungen) und die
-- Abrechnung je Event (Bestellungen/CSV) ergaben verschiedene Gebuehren.
-- Gruende:
--   1. Der Webhook konnte die Buchung beim Kauf meist noch nicht lesen
--      (Stripe legt die Balance-Transaction oft erst Sekunden spaeter an).
--      Die Buchungen kamen erst mit der Auszahlung - ohne Bestellung und
--      ohne Aufteilung Service/Zahlung.
--   2. KICKFORCE (10.10.) wurde geloescht; Bestellungen existieren noch,
--      aber ohne Event - die Buchungen tauchten in keiner Abrechnung auf.
--   3. Head-Admin sah in der Uebersicht auch die Konten anderer
--      Veranstalter (CORE-Baelle) - siehe storefront_stripe_accounts().
-- ============================================================
begin;

-- 1) Stripe-Konten eines Shops (Auszahlungsempfaenger seiner Events).
--    Head-Admin: alle Konten des Shops; sonst nur das eigene.
create or replace function public.storefront_stripe_accounts(p_storefront text)
returns setof text language sql stable security definer set search_path to 'public'
as $$
  select distinct a.stripe_account_id
    from events e join admins a on a.email = lower(e.owner_email)
   where e.storefront = p_storefront and a.stripe_account_id is not null
     and (is_super_admin() or a.email = lower(coalesce(auth.jwt()->>'email','')));
$$;
revoke all on function public.storefront_stripe_accounts(text) from public;
grant execute on function public.storefront_stripe_accounts(text) to authenticated;

-- 2) Unverknuepfte Buchungen den Bestellungen zuordnen: gleicher Betrag,
--    max. 30 Sekunden Abstand (echte Treffer liegen bei <= 5 s; bei
--    15 Minuten waren Serien gleicher 10-EUR-Kaeufe mehrdeutig),
--    beidseitig eindeutig UND Gebuehr der Buchung
--    = Service + Zahlung der Bestellung (Stripe zieht genau diese ab).
with b as (
  select * from stripe_balance_txns
   where order_id is null and reporting_category = 'charge'
), o as (
  select o.* from orders o
   where o.status = 'bezahlt' and o.paid_via = 'stripe' and o.total > 0
     and not exists (select 1 from stripe_balance_txns x where x.order_id = o.id)
), cand as (
  select b.balance_transaction_id bt, o.id oid
    from b join o on o.total = b.gross
     and abs(extract(epoch from b.created_at - coalesce(o.paid_at, o.created_at))) < 30
     and coalesce(o.service_fee,0) + coalesce(o.payment_fee,0) = b.fee
), uniq as (
  select bt, oid from cand
   where bt  in (select bt  from cand group by bt  having count(*) = 1)
     and oid in (select oid from cand group by oid having count(*) = 1)
)
update stripe_balance_txns t
   set order_id = o.id, service_fee = o.service_fee, payment_fee = o.payment_fee,
       split_source = 'bestellung'
  from uniq join orders o on o.id = uniq.oid
 where t.balance_transaction_id = uniq.bt;

-- 3) KICKFORCE (geloescht): Buchungen ueber die verwaisten Bestellungen
--    dem Archiveintrag zuordnen und die Abrechnung einfrieren.
update stripe_balance_txns t set archive_id = 'f111e6f9-810a-49e8-ac68-82712323f6c8'
  from orders o
 where t.order_id = o.id and o.event_id is null
   and exists (select 1 from order_items i where i.order_id = o.id and i.event_name ilike 'KICKFORCE pres.%');

update event_archive a set
  vat_rate = 13, fees_on_organizer = true,
  orders_count = s.n, gross = s.gross, customer_paid = s.gross,
  service_fee = s.svc, payment_fee = s.pay, payout = s.net, paid_tickets = s.tickets,
  finance_source = 'Aus Stripe-Buchungen und Bestellungen rekonstruiert (' || s.n || ' Zahlungen)'
  from (select t.archive_id, count(*) n, sum(t.gross) gross, sum(t.service_fee) svc,
               sum(t.payment_fee) pay, sum(t.net) net,
               (select count(*) from tickets k join stripe_balance_txns x on x.order_id = k.order_id
                 where x.archive_id = t.archive_id) tickets
          from stripe_balance_txns t
         where t.archive_id = 'f111e6f9-810a-49e8-ac68-82712323f6c8'
         group by t.archive_id) s
 where a.id = s.archive_id;

-- 4) Pruefungen - bei Abweichung bricht die ganze Migration ab
do $$
declare v_open int; v_kf numeric; v_bad int;
begin
  select count(*) into v_open from stripe_balance_txns
   where connected_account = 'acct_1UG3FoBk8hG4hMib' and payment_fee is null;
  select gross into v_kf from event_archive where id = 'f111e6f9-810a-49e8-ac68-82712323f6c8';
  select count(*) into v_bad from stripe_balance_txns
   where payment_fee is not null and service_fee + payment_fee <> fee;
  if v_open > 0 then raise exception 'Noch % Focus-Buchungen ohne Aufteilung', v_open; end if;
  if v_kf is distinct from 596 then raise exception 'KICKFORCE ergibt % statt 596', v_kf; end if;
  if v_bad > 0 then raise exception '% Buchungen: Service + Zahlung <> Gebuehr', v_bad; end if;
end $$;

notify pgrst, 'reload schema';
commit;
