-- ============================================================
-- Focus Events – VIP-Tische mit FREIER Terminwahl
-- ------------------------------------------------------------
-- Der Gast kann einen beliebigen Tag wählen (nicht nur Event-Tage).
-- Die VIP-Einrichtung (Grundriss/Tische/Getränke) eines Clubs dient
-- als Vorlage; Verfügbarkeit ist pro Tisch UND Datum. Reservierungen
-- erhalten res_date und werden im Dashboard mit Datum angezeigt.
-- ============================================================
begin;

alter table public.table_reservations add column if not exists res_date date;

-- Exklusivität jetzt pro (Tisch, Datum) statt global pro Tisch.
drop index if exists table_res_one_active;
create unique index if not exists table_res_one_active_date
  on public.table_reservations (table_id, res_date) where status = 'reserviert';

-- Tischstatus datumsabhängig (frei/belegt am gewählten Tag).
drop function if exists public.table_status(uuid);
create or replace function public.table_status(p_event uuid, p_date date)
returns table(id uuid, name text, min_consumption numeric, capacity int, sort int, taken boolean)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, t.min_consumption, t.capacity, t.sort,
    exists (select 1 from table_reservations r
            where r.table_id = t.id and r.status = 'reserviert'
              and r.res_date is not distinct from p_date) as taken
  from event_tables t
  where t.event_id = p_event and t.active
  order by t.sort, t.name;
$$;
grant execute on function public.table_status(uuid, date) to anon, authenticated;

-- Reservierung mit Datum (atomar, exklusiv pro Tisch & Tag).
drop function if exists public.reserve_table(uuid, text, text, int, jsonb);
create or replace function public.reserve_table(
  p_table uuid, p_date date, p_guest_name text, p_phone text, p_drinks jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      text := lower(coalesce(auth.jwt()->>'email',''));
  t       event_tables;
  v_total numeric := 0;
  d       jsonb;
  v_res   uuid;
begin
  if me = '' then raise exception 'Bitte zuerst anmelden.'; end if;
  if p_date is null then raise exception 'Bitte ein Datum wählen.'; end if;
  select * into t from event_tables where id = p_table and active;
  if not found then raise exception 'Tisch nicht verfügbar.'; end if;

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

  return jsonb_build_object('id', v_res, 'table', t.name, 'date', p_date);
exception when unique_violation then
  raise exception 'Dieser Tisch ist an diesem Datum bereits reserviert. Bitte anderen Tisch oder Termin wählen.';
end $$;
grant execute on function public.reserve_table(uuid, date, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
