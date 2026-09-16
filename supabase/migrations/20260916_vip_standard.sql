-- ============================================================
-- Focus Events – VIP-Standard-Konfiguration je Club
-- ------------------------------------------------------------
-- Tischauswahl pro Datum:
--  * Findet an dem Tag ein Event statt (mit VIP), zeige dessen
--    EVENT-SPEZIFISCHE Tische.
--  * Sonst (freier Tag) zeige die STANDARD-Tische des Clubs.
-- Der Veranstalter markiert EIN VIP-Event je Club als Standard
-- (vip_standard=true). Ohne Markierung gilt als Fallback das
-- früheste VIP-Event des Clubs.
-- Der frühere Sperrtermin-Ansatz entfällt (vip_blackout_dates bleibt
-- ungenutzt bestehen).
-- ============================================================
begin;
alter table public.events add column if not exists vip_standard boolean not null default false;
-- Test-Sperrtermin aus der Entwicklung entfernen
update public.events set vip_blackout_dates = '[]'::jsonb where vip_blackout_dates <> '[]'::jsonb;
notify pgrst, 'reload schema';
commit;
