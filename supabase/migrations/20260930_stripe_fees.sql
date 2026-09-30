-- ============================================================
-- Tatsächliche Stripe-Kosten je Bestellung mitschreiben
-- ------------------------------------------------------------
-- Bisher war nur die VERRECHNETE Zahlungsgebühr bekannt
-- (orders.payment_fee), nicht was Stripe real abzieht. Der Webhook
-- holt die Werte künftig aus der Balance-Transaction und legt sie
-- hier ab – Grundlage für die Abrechnung im Dashboard.
--
-- Nur für NEUE Zahlungen; rückwirkend nicht befüllbar (bleibt NULL).
-- Additiv/nicht brechend.
-- ============================================================
begin;

alter table public.orders
  add column if not exists stripe_fee    numeric(10,2),  -- was Stripe real abzieht
  add column if not exists stripe_net    numeric(10,2),  -- Betrag nach Stripe-Gebühr
  add column if not exists stripe_payout numeric(10,2),  -- an den Veranstalter überwiesen
  add column if not exists stripe_payment_intent text;   -- zur Nachverfolgung in Stripe

create index if not exists orders_stripe_pi_idx on public.orders (stripe_payment_intent);

notify pgrst, 'reload schema';
commit;
