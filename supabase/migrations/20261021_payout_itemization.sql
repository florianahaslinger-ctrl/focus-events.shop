-- ============================================================
-- Focus Events – Auszahlungsbeleg je Stripe-Auszahlung + Archiv-Abrechnung
-- ------------------------------------------------------------
-- Steuerberater: Jede Stripe-Auszahlung wird einzeln verbucht und einer
-- Kostenstelle (= Event) zugeordnet. Dafuer liefert payout_itemization()
-- jede Zahlung mit Auszahlung, Event, Bestellung, Artikeln, MwSt-Satz und
-- Gebuehren – serverseitig, damit auch Zahlungen geloeschter Events
-- vollstaendig sind (Bestellungen ohne Event sind per RLS sonst unsichtbar).
--
-- archive_freeze_finance(): friert beim Archivieren die Abrechnung eines
-- Events im Archiv ein. Wird das Event spaeter geloescht, bleibt es in der
-- Abrechnung (vorher fiel es heraus – zuletzt KICKFORCE und DIRNDL RAVE).
-- ============================================================
begin;

-- 1) Abrechnung im Archiv einfrieren -------------------------------------
--    p_event gesetzt: Bestellungen dieses (noch vorhandenen) Events.
--    p_event leer:    Event bereits geloescht -> Bestellungen ohne Event,
--                     deren Artikel den Archivnamen tragen (nur Head-Admin).
create or replace function public.archive_freeze_finance(p_archive uuid, p_event uuid default null)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare a event_archive; v_rate numeric; v_foo boolean; r record;
begin
  select * into a from event_archive where id = p_archive;
  if not found then raise exception 'Archiveintrag nicht gefunden'; end if;
  if not (is_super_admin() or (p_event is not null and owns_event_id(p_event))) then
    raise exception 'Keine Berechtigung';
  end if;

  drop table if exists _fz_orders;
  create temp table _fz_orders on commit drop as
    select o.* from orders o
     where o.status = 'bezahlt' and o.subtotal > 0
       and (case when p_event is not null then o.event_id = p_event
                 else o.event_id is null and exists (select 1 from order_items i
                        where i.order_id = o.id and i.event_name = a.name) end);

  select e.vat_rate, e.fees_on_organizer into v_rate, v_foo from events e where e.id = p_event;
  select count(*) n, coalesce(sum(subtotal),0) gross, coalesce(sum(total),0) paid,
         coalesce(sum(service_fee),0) svc, coalesce(sum(payment_fee),0) pay,
         (select count(*) from tickets t where t.order_id in (select id from _fz_orders)) tickets
    into r from _fz_orders;
  if r.n = 0 then raise exception 'Keine bezahlten Bestellungen gefunden'; end if;

  update event_archive set
    vat_rate = coalesce(v_rate, vat_rate, 13), fees_on_organizer = coalesce(v_foo, fees_on_organizer, true),
    orders_count = r.n, paid_tickets = r.tickets, gross = r.gross, customer_paid = r.paid,
    service_fee = r.svc, payment_fee = r.pay, payout = r.paid - r.svc - r.pay,
    finance_source = 'Beim Archivieren aus ' || r.n || ' Bestellungen eingefroren'
   where id = p_archive;

  update stripe_balance_txns set archive_id = p_archive
   where order_id in (select id from _fz_orders) and archive_id is null;

  return jsonb_build_object('orders', r.n, 'gross', r.gross, 'tickets', r.tickets);
end $$;
revoke all on function public.archive_freeze_finance(uuid, uuid) from public;
grant execute on function public.archive_freeze_finance(uuid, uuid) to authenticated;

-- 2) Auszahlungsbeleg: jede Zahlung mit Kostenstelle -----------------------
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
         coalesce(ev.vat_rate, ar.vat_rate),
         b.gross, b.service_fee, b.payment_fee, b.fee, b.net
    from stripe_balance_txns b
    left join orders o on o.id = b.order_id
    left join events ev on ev.id = o.event_id
    left join event_archive ar on ar.id = b.archive_id
   where b.connected_account in (select storefront_stripe_accounts(p_storefront))
     and b.reporting_category = 'charge'
   order by b.payout_at nulls first, b.created_at;
$$;
revoke all on function public.payout_itemization(text) from public;
grant execute on function public.payout_itemization(text) to authenticated;

notify pgrst, 'reload schema';
commit;
