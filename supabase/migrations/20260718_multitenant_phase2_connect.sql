-- ============================================================
-- Multi-Mandanten – Phase 2: Stripe Connect (Express) je Veranstalter
-- Speichert das verbundene Stripe-Konto und ob es Zahlungen empfangen kann.
-- Wird von den Edge Functions (service_role) gepflegt; Veranstalter dürfen
-- ihren eigenen Status lesen (über die is_admin/owns-Policies bereits erlaubt).
-- ============================================================
alter table public.admins add column if not exists stripe_account_id text;
alter table public.admins add column if not exists stripe_charges_enabled boolean not null default false;

notify pgrst, 'reload schema';
