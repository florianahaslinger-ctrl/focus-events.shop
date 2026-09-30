-- ============================================================
-- Stripe-Buchungen je Veranstalterkonto (Auszahlungsübersicht)
-- ------------------------------------------------------------
-- Speichert die Einzelbuchungen aus dem Stripe-Bericht
-- „Connected account – Itemized balance change from activity“.
-- Zweck: Auszahlungen im Dashboard nachvollziehbar machen – auch
-- für Events, deren Bestellungen gelöscht wurden (die Geldflüsse
-- existieren dann nur noch hier).
--
-- Begriffe (aus Sicht des Veranstalterkontos, Destination Charge):
--   gross = Kundenbetrag · fee = Gebühr an die Plattform (CORE)
--   net   = beim Veranstalter angekommen
-- Stripes eigene Bearbeitungsgebühr ist NICHT enthalten – sie fällt
-- auf dem Plattformkonto an.
--
-- balance_transaction_id ist Primärschlüssel -> Re-Import idempotent.
-- ============================================================
begin;

create table if not exists public.stripe_balance_txns (
  balance_transaction_id text primary key,
  connected_account      text not null,
  source_id              text,
  reporting_category     text,
  created_at             timestamptz not null,
  available_on           timestamptz,
  gross                  numeric(12,2) not null,
  fee                    numeric(12,2) not null default 0,
  net                    numeric(12,2) not null,
  currency               text not null default 'eur',
  payout_id              text,
  payout_at              timestamptz,
  order_id               text references public.orders(id) on delete set null,
  source                 text not null default 'csv_import',
  imported_at            timestamptz not null default now()
);
create index if not exists sbt_account_idx on public.stripe_balance_txns (connected_account, created_at);
create index if not exists sbt_payout_idx  on public.stripe_balance_txns (payout_id);

alter table public.stripe_balance_txns enable row level security;

-- Head-Admin sieht alles, Veranstalter nur das eigene Stripe-Konto.
drop policy if exists sbt_read on public.stripe_balance_txns;
create policy sbt_read on public.stripe_balance_txns for select using (
  public.is_super_admin()
  or connected_account = (
    select a.stripe_account_id from public.admins a
    where a.email = lower(coalesce(auth.jwt()->>'email',''))
  )
);
-- Schreiben nur serverseitig (Import/Service-Role), nicht aus dem Browser.

notify pgrst, 'reload schema';
commit;
