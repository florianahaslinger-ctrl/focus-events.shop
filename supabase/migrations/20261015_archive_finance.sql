-- ============================================================
-- Focus Events – Abrechnung fuer geloeschte (archivierte) Events
-- ------------------------------------------------------------
-- REOPENING (19.09.) und Black Circus (26.09.) wurden geloescht; ihre
-- Bestellungen gibt es nicht mehr. Die Stripe-Buchungen des Focus-Kontos
-- (stripe_balance_txns) sind aber vollstaendig vorhanden.
--
-- Zuordnung (eindeutig, auf den Cent geprueft):
--   * REOPENING: alle Zahlungen 16.09. bis 19.09. 21:01 UTC (letzte
--     REOPENING-Bestellung 21:00:33, Preise 8/10/12 EUR) plus die
--     10-EUR-Zahlung txn_1UHVOOBk8hG4hMibyeKfGSPv um 21:01:52 (Late Bird
--     dieser letzten Bestellung)                       -> 3.472,00 EUR
--   * Black Circus: alle uebrigen Zahlungen bis zur Event-Nacht
--     (ab 19.09. 21:01:34, ausschliesslich 8-EUR-Tickets) -> 1.088,00 EUR
--   * 1,27 EUR am 15.09. = Testzahlung, keinem Event zugeordnet.
-- Beide Summen stimmen exakt mit dem Ticketumsatz im Archiv ueberein.
-- Gebuehren waren vom Veranstalter getragen (Kunde zahlte nur den Ticketpreis).
-- Steuersatz 13 % wie bei allen Focus-Events (nicht aus Stripe ableitbar).
-- ============================================================
begin;

alter table public.event_archive
  add column if not exists vat_rate          numeric(5,2),
  add column if not exists orders_count      integer,
  add column if not exists paid_tickets      integer,
  add column if not exists gross             numeric(12,2),   -- Ticketumsatz brutto
  add column if not exists service_fee       numeric(12,2),   -- an CORE
  add column if not exists payment_fee       numeric(12,2),   -- deckt Stripe
  add column if not exists customer_paid     numeric(12,2),
  add column if not exists payout            numeric(12,2),   -- an die GmbH
  add column if not exists fees_on_organizer boolean,
  add column if not exists finance_source    text;

alter table public.stripe_balance_txns
  add column if not exists archive_id uuid references public.event_archive(id) on delete set null;

-- Buchungen den archivierten Events zuordnen (Nachvollziehbarkeit)
update public.stripe_balance_txns set archive_id = 'd17f8acb-3c38-4606-bae5-eb80b2acc871'
 where connected_account = 'acct_1UG3FoBk8hG4hMib' and reporting_category = 'charge'
   and ((created_at >= '2026-09-16' and created_at < '2026-09-19 21:01:00+00')
        or balance_transaction_id = 'txn_1UHVOOBk8hG4hMibyeKfGSPv');

update public.stripe_balance_txns set archive_id = 'ec7598cf-a250-46d7-addf-3ae42b71d1ae'
 where connected_account = 'acct_1UG3FoBk8hG4hMib' and reporting_category = 'charge'
   and created_at >= '2026-09-19 21:01:00+00' and created_at < '2026-09-27 04:00+00'
   and balance_transaction_id <> 'txn_1UHVOOBk8hG4hMibyeKfGSPv';

-- Kennzahlen aus den zugeordneten Buchungen einfrieren
update public.event_archive a set
  vat_rate = 13, fees_on_organizer = true,
  orders_count = s.n, gross = s.gross, customer_paid = s.gross,
  service_fee = s.svc, payment_fee = s.pay, payout = s.net,
  paid_tickets = case a.id when 'd17f8acb-3c38-4606-bae5-eb80b2acc871' then 339 else 136 end,
  finance_source = 'Aus Stripe-Buchungen rekonstruiert (' || s.n || ' Zahlungen)'
from (select archive_id, count(*) n, sum(gross) gross, sum(service_fee) svc,
             sum(payment_fee) pay, sum(net) net
        from public.stripe_balance_txns where archive_id is not null group by archive_id) s
where a.id = s.archive_id;

-- Sicherung: Ticketumsatz muss exakt dem Archiv entsprechen, sonst Abbruch
do $$
begin
  if exists (select 1 from public.event_archive
             where id in ('d17f8acb-3c38-4606-bae5-eb80b2acc871','ec7598cf-a250-46d7-addf-3ae42b71d1ae')
               and (gross is null or gross <> revenue or service_fee + payment_fee + payout <> gross)) then
    raise exception 'Rekonstruktion passt nicht zum Archiv - abgebrochen';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
