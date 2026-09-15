-- ============================================================
-- Focus Events – Verfügbarkeitsanzeige je Event optional
-- ------------------------------------------------------------
-- Der Veranstalter kann pro Event ein-/ausschalten, ob im Shop die
-- verbleibende Ticketanzahl angezeigt wird ("800 verfügbar" /
-- "Nur noch 2 verfügbar"). Standard: an (true) wie bisher.
-- "Ausverkauft" wird unabhängig davon weiter angezeigt.
-- Additiv/nicht brechend; events wird mit CORE geteilt (ignoriert die Spalte).
-- ============================================================
begin;
alter table public.events add column if not exists show_availability boolean not null default true;
notify pgrst, 'reload schema';
commit;
