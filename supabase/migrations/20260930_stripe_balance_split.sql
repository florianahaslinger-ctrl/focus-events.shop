-- ============================================================
-- stripe_balance_txns: Gebühr aufteilen + echte Stripe-Kosten
-- ------------------------------------------------------------
-- "fee" (Plattformgebühr) besteht aus zwei Teilen:
--   service_fee  – Servicegebühr, verbleibt bei CORE
--   payment_fee  – Zahlungsgebühr, deckt Stripes Bearbeitungsgebühr
-- stripe_fee     – was Stripe TATSÄCHLICH berechnet hat (Plattformkonto),
--                  nur für Zahlungen, die der Webhook live erfasst.
-- split_source   – woher die Aufteilung stammt:
--                  'bestellung' = aus orders.service_fee/payment_fee
--                  'berechnet'  = aus Betrag und Gebührenformel zurückgerechnet
-- Additiv/nicht brechend.
-- ============================================================
begin;
alter table public.stripe_balance_txns
  add column if not exists service_fee  numeric(12,2),
  add column if not exists payment_fee  numeric(12,2),
  add column if not exists stripe_fee   numeric(12,2),
  add column if not exists split_source text;
notify pgrst, 'reload schema';
commit;
