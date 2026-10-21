-- ============================================================
-- Focus Events – VIP-Reservierungen gegen Loeschen absichern
-- ------------------------------------------------------------
-- Am 21.10.2026 wurde DIRNDL RAVE (LEVEL) geloescht. Seine Tische waren
-- die Standard-Tische von LEVEL fuer freie Tage – per ON DELETE CASCADE
-- verschwanden damit auch 3 bestaetigte Reservierungen fuer Dezember.
--
-- 1) Loeschschutz: Events bzw. Tische mit kommenden Reservierungen
--    koennen nicht mehr geloescht werden (Deaktivieren/Archivieren geht).
-- 2) Standard-Quelle je Club: dauerhafte VIP-Bereiche (Event ohne Datum,
--    z. B. "VIP TISCHE Level") haben Vorrang vor datierten Events.
-- 3) "VIP TISCHE Ypsilon" war versehentlich dem Club LEVEL zugeordnet.
-- 4) Die 3 verlorenen Reservierungen werden auf den Tischen von
--    "VIP TISCHE Level" wiederhergestellt (Name/Telefon/Getraenke nicht
--    mehr vorhanden – Name aus dem Kundenkonto).
-- ============================================================
begin;

-- 1) Loeschschutz -------------------------------------------------------
create or replace function public.protect_vip_reservations()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare v_n int; v_dates text;
begin
  select count(*), string_agg(distinct to_char(r.res_date, 'DD.MM.YYYY'), ', ')
    into v_n, v_dates
    from table_reservations r
   where r.status = 'reserviert' and r.res_date >= current_date
     and (case when tg_table_name = 'events' then r.event_id = old.id else r.table_id = old.id end);
  if v_n > 0 then
    raise exception 'Nicht moeglich: % kommende VIP-Reservierung(en) (%) haengen daran. Bitte deaktivieren oder archivieren statt loeschen.', v_n, v_dates;
  end if;
  return old;
end $$;

drop trigger if exists protect_vip_res_events on public.events;
create trigger protect_vip_res_events before delete on public.events
  for each row execute function public.protect_vip_reservations();
drop trigger if exists protect_vip_res_tables on public.event_tables;
create trigger protect_vip_res_tables before delete on public.event_tables
  for each row execute function public.protect_vip_reservations();

-- 2) Standard-Quelle: dauerhafte VIP-Bereiche zuerst --------------------
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
  order by e.vip_standard desc,
           (e.date is null) desc,                         -- dauerhafter VIP-Bereich
           e.active desc,
           case when e.active then e.date end asc nulls last,
           e.date desc nulls last,
           e.created_at asc;
$$;

-- 3) Club-Zuordnung korrigieren -----------------------------------------
update public.events set club = 'YPSILON'
 where storefront = 'focus' and name = 'VIP TISCHE Ypsilon' and club = 'LEVEL';

-- 4) Verlorene Reservierungen wiederherstellen --------------------------
with src as (
  select o.id order_id, lower(o.email) email, o.created_at, t.event_date::date res_date, i.category_name,
         (select u.raw_user_meta_data->>'full_name' from auth.users u where lower(u.email) = lower(o.email)) guest
    from orders o
    join order_items i on i.order_id = o.id
    join tickets t on t.order_id = o.id
   where o.id in ('VIP-14E8D6EED1', 'VIP-571A1D97DB', 'VIP-DD7F04E70F') and o.status = 'bezahlt'
), tbl as (
  select t.id, t.event_id, t.min_consumption,
         case when t.name ilike 'VIP%LOUNGE%' then 'vip' when t.name ilike 'FRIEND%' then 'friends' end kind
    from event_tables t join events e on e.id = t.event_id
   where e.name = 'VIP TISCHE Level' and e.club = 'LEVEL' and e.storefront = 'focus'
)
insert into table_reservations (event_id, table_id, email, guest_name, res_date, min_consumption,
                                drinks, drinks_total, status, created_at, order_id)
select tbl.event_id, tbl.id, src.email, src.guest, src.res_date, tbl.min_consumption,
       '[]'::jsonb, 0, 'reserviert', src.created_at, src.order_id
  from src join tbl on tbl.kind = case when src.category_name ilike '%friend%' then 'friends' else 'vip' end
 where not exists (select 1 from table_reservations r where r.order_id = src.order_id);

update orders set event_id = (select id from events where name = 'VIP TISCHE Level' and storefront = 'focus')
 where id in ('VIP-14E8D6EED1', 'VIP-571A1D97DB', 'VIP-DD7F04E70F') and event_id is null;

do $$
declare v_n int; v_club text;
begin
  select count(*) into v_n from table_reservations
   where order_id in ('VIP-14E8D6EED1', 'VIP-571A1D97DB', 'VIP-DD7F04E70F') and status = 'reserviert';
  if v_n <> 3 then raise exception 'Wiederherstellung unvollstaendig: % von 3', v_n; end if;
  select club into v_club from events where name = 'VIP TISCHE Ypsilon' and storefront = 'focus';
  if v_club <> 'YPSILON' then raise exception 'Club-Korrektur fehlgeschlagen'; end if;
end $$;

notify pgrst, 'reload schema';
commit;
