-- ============================================================
-- Focus Events – VIP-Sperrtermine (kein VIP an bestimmten Tagen)
-- ------------------------------------------------------------
-- Die VIP-Einrichtung eines Clubs (Vorlage-Event) gilt für alle frei
-- gewählten Tage. Mit vip_blackout_dates kann der Veranstalter einzelne
-- Tage ausnehmen (z. B. 2026-09-19), an denen KEINE VIP-Tische angeboten
-- werden – ohne die Tische selbst zu entfernen.
-- Liste von 'YYYY-MM-DD'-Strings. Additiv/nicht brechend.
-- ============================================================
begin;
alter table public.events add column if not exists vip_blackout_dates jsonb not null default '[]'::jsonb;
notify pgrst, 'reload schema';
commit;
