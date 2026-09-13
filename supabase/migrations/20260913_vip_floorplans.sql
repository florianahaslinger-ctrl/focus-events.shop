-- ============================================================
-- Focus Events – VIP: mehrere Grundriss-Bilder je Event
-- ------------------------------------------------------------
-- Bisher ein einzelnes Grundriss-Bild (vip_floorplan_url). Jetzt
-- eine Liste (vip_floorplans = JSON-Array von URLs). Das bisherige
-- Einzelbild wird in die Liste übernommen; die alte Spalte bleibt
-- (führt das erste Bild) für Abwärtskompatibilität erhalten.
-- ============================================================
begin;

alter table public.events add column if not exists vip_floorplans jsonb not null default '[]'::jsonb;

update public.events
   set vip_floorplans = jsonb_build_array(vip_floorplan_url)
 where vip_floorplan_url is not null and vip_floorplan_url <> ''
   and (vip_floorplans is null or vip_floorplans = '[]'::jsonb);

notify pgrst, 'reload schema';
commit;
