-- ============================================================
-- Focus Events – VIP-Tische auch ohne aktives Event
-- ------------------------------------------------------------
-- Bisher las der Shop die VIP-Quelle (Tische, Plan, Getraenke) aus den
-- AKTIVEN Events. War kein Event online, gab es keine Quelle mehr und
-- die Tischreservierung an freien Tagen fiel komplett aus.
--
-- Neu: vip_sources() liefert alle Events mit eingeschaltetem VIP-Bereich
-- und mindestens einem aktiven Tisch - auch deaktivierte/archivierte.
-- Bewusst OHNE Name und Datum, damit unveroeffentlichte Events nicht
-- durchsickern. Reihenfolge = Rangfolge der Standard-Quelle je Club:
--   1. als Standard markiert  2. aktiv (fruehestes zuerst)
--   3. deaktiviert (zuletzt stattgefundenes zuerst)
-- ============================================================
begin;

create or replace function public.vip_sources(p_storefront text)
returns table(id uuid, club text, location text, active boolean, vip_standard boolean,
              vip_info text, vip_floorplan_url text, vip_floorplans jsonb)
language sql stable security definer set search_path to 'public'
as $$
  select e.id, e.club, e.location, e.active, e.vip_standard,
         e.vip_info, e.vip_floorplan_url, e.vip_floorplans
  from events e
  where e.storefront = p_storefront
    and e.vip_enabled
    and exists (select 1 from event_tables t where t.event_id = e.id and t.active)
  order by e.vip_standard desc, e.active desc,
           case when e.active then e.date end asc nulls last,
           e.date desc nulls last;
$$;
revoke all on function public.vip_sources(text) from public;
grant execute on function public.vip_sources(text) to anon, authenticated;

-- Getraenkekarte: auch lesbar, wenn das Event deaktiviert ist, der
-- VIP-Bereich aber weiterlaeuft. Die Pruefung laeuft ueber eine
-- SECURITY-DEFINER-Funktion, weil Gaeste deaktivierte Events selbst
-- nicht lesen duerfen (RLS auf events) - eine Unterabfrage saehe sie nicht.
create or replace function public.event_drinks_public(p_event uuid)
returns boolean language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from events e where e.id = p_event and (e.active or e.vip_enabled));
$$;
revoke all on function public.event_drinks_public(uuid) from public;
grant execute on function public.event_drinks_public(uuid) to anon, authenticated;

drop policy if exists event_drinks_read on public.event_drinks;
create policy event_drinks_read on public.event_drinks for select using (
  event_drinks_public(event_id) or owns_event_id(event_id)
);

notify pgrst, 'reload schema';
commit;
