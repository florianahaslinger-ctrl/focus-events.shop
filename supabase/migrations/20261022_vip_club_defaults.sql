-- ============================================================
-- Focus Events – VIP-Tische: Voreinstellung je Club
-- ------------------------------------------------------------
-- Regeln (Vorgabe Florian, 22.10.2026):
--   * Tische sind fuer LEVEL und YPSILON an JEDEM Tag reservierbar.
--   * Je Club gibt es eine VIP-Voreinstellung (Tische, Grundriss,
--     Getraenke, Hinweistext) – die bisherigen Platzhalter-Events
--     "VIP TISCHE Level" / "VIP TISCHE Ypsilon".
--   * Tage ohne Event: es gilt die Voreinstellung.
--   * Tage mit Event: es gelten die Regeln des Events –
--       Haken "Standard-VIP-Einstellung" gesetzt -> Voreinstellung,
--       sonst die eigenen Tische des Events (keine Tische = an diesem
--       Tag keine Tischreservierung).
--   * Der Server prueft bei jeder Reservierung, ob der Tisch an diesem
--     Tag der gueltige ist – so kann derselbe echte Tisch nicht ueber
--     zwei Tischlisten doppelt vergeben werden.
-- ============================================================
begin;

alter table public.events
  add column if not exists vip_use_standard boolean not null default true,
  add column if not exists vip_club_default boolean not null default false;

-- 1) Voreinstellungen markieren (je Shop und Club genau eine)
update public.events set vip_club_default = true, vip_enabled = true, vip_use_standard = false, active = false
 where storefront = 'focus' and name in ('VIP TISCHE Level', 'VIP TISCHE Ypsilon');
create unique index if not exists events_one_vip_default_per_club
  on public.events (storefront, upper(club)) where vip_club_default;

-- YPSILON-Voreinstellung hatte keine Getraenkekarte -> die (ueberall gleiche) Karte uebernehmen
insert into public.event_drinks (event_id, name, price, sort)
select y.id, d.name, d.price, d.sort
  from public.events y
  join public.events l on l.storefront = 'focus' and l.vip_club_default and upper(l.club) = 'LEVEL'
  join public.event_drinks d on d.event_id = l.id
 where y.storefront = 'focus' and y.vip_club_default and upper(y.club) = 'YPSILON'
   and not exists (select 1 from public.event_drinks x where x.event_id = y.id);

-- 2) Bestehende Events einordnen: identische Tische (Name normalisiert + Mindestkonsum)
--    oder gar keine eigenen Tische -> Standard. Abweichende Tische bleiben eigene Regeln.
create or replace function public.vip_table_key(p_name text) returns text
language sql immutable as $$
  select replace(regexp_replace(lower(regexp_replace(p_name, '\(.*?\)', '', 'g')), '[^a-z0-9]', '', 'g'), 'friends', 'friend');
$$;

with sig as (
  select e.id, e.club, e.vip_club_default,
         coalesce((select string_agg(vip_table_key(t.name) || ':' || t.min_consumption, ',' order by vip_table_key(t.name))
                     from public.event_tables t where t.event_id = e.id and t.active), '') s
    from public.events e where e.storefront = 'focus'
)
update public.events e set
  vip_use_standard = (x.s = '' or x.s = d.s),
  vip_enabled = case when (x.s = '' or x.s = d.s) then true else e.vip_enabled end
  from sig x join sig d on d.vip_club_default and upper(d.club) = upper(x.club)
 where e.id = x.id and not x.vip_club_default;

-- 3) Kommende Reservierungen von Events, die jetzt die Voreinstellung nutzen,
--    auf den gleichnamigen Tisch der Voreinstellung umhaengen
with mv as (
  select r.id rid, dt.id new_table, dt.event_id new_event
    from public.table_reservations r
    join public.events e on e.id = r.event_id and e.vip_use_standard and not e.vip_club_default and e.storefront = 'focus'
    join public.event_tables t on t.id = r.table_id
    join public.events de on de.vip_club_default and de.storefront = e.storefront and upper(de.club) = upper(e.club)
    join public.event_tables dt on dt.event_id = de.id and dt.active and vip_table_key(dt.name) = vip_table_key(t.name)
   where r.status = 'reserviert' and r.res_date >= current_date
)
update public.table_reservations r set table_id = mv.new_table, event_id = mv.new_event
  from mv where r.id = mv.rid;

-- 4) Welche Tischliste gilt an einem Tag?
create or replace function public.vip_source_for(p_storefront text, p_club text, p_date date)
returns uuid language sql stable security definer set search_path to 'public'
as $$
  with def as (
    select id from events where storefront = p_storefront and upper(club) = upper(p_club) and vip_club_default limit 1
  ), day as (
    select e.id, e.vip_use_standard from events e
     where e.storefront = p_storefront and upper(e.club) = upper(p_club) and e.active and not e.vip_club_default
       and e.date is not null and (e.date at time zone 'Europe/Vienna')::date = p_date
     order by e.date limit 1
  )
  select case
    when not exists (select 1 from day) then (select id from def)
    when (select vip_use_standard from day) then (select id from def)
    when exists (select 1 from event_tables t where t.event_id = (select id from day) and t.active) then (select id from day)
    else null
  end;
$$;
revoke all on function public.vip_source_for(text, text, date) from public;
grant execute on function public.vip_source_for(text, text, date) to anon, authenticated;

-- 5) Quellen fuer den Shop: Voreinstellungen + aktive Events mit eigenen Tischen
create or replace function public.vip_sources(p_storefront text)
returns table(id uuid, club text, location text, active boolean, vip_standard boolean,
              vip_info text, vip_floorplan_url text, vip_floorplans jsonb)
language sql stable security definer set search_path to 'public'
as $$
  select e.id, e.club, e.location, e.active, e.vip_club_default,
         e.vip_info, e.vip_floorplan_url, e.vip_floorplans
    from events e
   where e.storefront = p_storefront
     and (e.vip_club_default
          or (e.active and not e.vip_use_standard
              and exists (select 1 from event_tables t where t.event_id = e.id and t.active)))
   order by e.vip_club_default desc, e.date nulls first;
$$;

-- 6) Reservieren: nur der an diesem Tag gueltige Tisch
create or replace function public.reserve_table(p_table uuid, p_date date, p_guest_name text, p_phone text, p_drinks jsonb)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  me      text := lower(coalesce(auth.jwt()->>'email',''));
  t       event_tables;
  ev      events;
  v_total numeric := 0;
  d       jsonb;
  v_res   uuid;
  v_order text;
  v_label text;
begin
  if me = '' then raise exception 'Bitte zuerst anmelden.'; end if;
  if p_date is null then raise exception 'Bitte ein Datum wählen.'; end if;
  if p_date < (now() at time zone 'Europe/Vienna')::date then raise exception 'Dieses Datum liegt in der Vergangenheit.'; end if;
  select * into t from event_tables where id = p_table and active;
  if not found then raise exception 'Tisch nicht verfügbar.'; end if;
  select * into ev from events where id = t.event_id;
  if vip_source_for(ev.storefront, ev.club, p_date) is distinct from t.event_id then
    raise exception 'Dieser Tisch ist an diesem Tag nicht buchbar. Bitte die Seite neu laden und den Tisch erneut wählen.';
  end if;

  if p_drinks is not null then
    for d in select * from jsonb_array_elements(p_drinks) loop
      v_total := v_total + coalesce((d->>'price')::numeric, 0) * coalesce((d->>'qty')::int, 0);
    end loop;
  end if;

  insert into table_reservations
    (event_id, table_id, email, guest_name, phone, res_date, min_consumption, drinks, drinks_total)
  values
    (t.event_id, t.id, me, nullif(p_guest_name,''), nullif(p_phone,''), p_date,
     t.min_consumption, coalesce(p_drinks, '[]'::jsonb), v_total)
  returning id into v_res;

  v_label := coalesce(ev.club, 'FOCUS') || ' · VIP-Tisch';
  v_order := 'VIP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into orders (id, email, status, total, paid_via, paid_at, event_id)
    values (v_order, me, 'bezahlt', 0, 'vip-tisch', now(), t.event_id);
  insert into order_items (order_id, category_id, event_name, category_name, price, qty)
    values (v_order, null, v_label, 'VIP-Tisch ' || t.name, 0, 1);
  insert into tickets (code, order_id, category_id, event_name, event_date, event_location, category_name, price)
    values (gen_ticket_code(), v_order, null, v_label, p_date::timestamptz, ev.location, 'VIP-Tisch ' || t.name, 0);
  update table_reservations set order_id = v_order where id = v_res;

  return jsonb_build_object('id', v_res, 'table', t.name, 'date', p_date, 'order', v_order);
exception when unique_violation then
  raise exception 'Dieser Tisch ist an diesem Datum bereits reserviert. Bitte anderen Tisch oder Termin wählen.';
end $function$;

-- 7) Voreinstellungen nicht loeschbar
create or replace function public.protect_vip_reservations()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare v_n int; v_dates text;
begin
  if tg_table_name = 'events' and old.vip_club_default then
    raise exception 'Die VIP-Voreinstellung eines Clubs kann nicht gelöscht werden.';
  end if;
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

-- 8) Pruefungen
do $$
declare v_def int; v_bad int;
begin
  select count(*) into v_def from events where storefront = 'focus' and vip_club_default;
  if v_def <> 2 then raise exception 'Erwartet 2 Voreinstellungen, gefunden %', v_def; end if;
  -- jede kommende Reservierung muss auf der an ihrem Tag gueltigen Tischliste liegen
  select count(*) into v_bad from table_reservations r join events e on e.id = r.event_id
   where r.status = 'reserviert' and r.res_date >= current_date and e.storefront = 'focus'
     and vip_source_for(e.storefront, e.club, r.res_date) is distinct from r.event_id;
  if v_bad > 0 then raise exception '% kommende Reservierung(en) liegen auf einer falschen Tischliste', v_bad; end if;
end $$;

notify pgrst, 'reload schema';
commit;
