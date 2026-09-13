-- ============================================================
-- Focus Events – VIP-Tisch: Eintrittstickets inklusive
-- ------------------------------------------------------------
-- Eine VIP-Tisch-Reservierung enthält jetzt kostenlose Eintritts-
-- tickets. Der Gast wählt die Anzahl beim Reservieren, begrenzt
-- durch die je Tisch konfigurierbare Kapazität (max. Tickets).
-- Weiterhin keine Online-Zahlung: es wird eine 0-€-Bestellung
-- (status 'bezahlt', paid_via 'vip-tisch') mit gültigen Tickets
-- erzeugt -> erscheinen unter „Meine Tickets" und sind am Einlass
-- scanbar. Storno der Reservierung storniert auch diese Tickets.
-- ============================================================
begin;

-- Kapazität (max. Tickets) je Tisch
alter table public.event_tables add column if not exists capacity int not null default 10 check (capacity >= 1);
-- Verknüpfung Reservierung -> erzeugte Bestellung (für Storno)
alter table public.table_reservations add column if not exists order_id text references public.orders(id) on delete set null;

-- Tischstatus inkl. Kapazität (Rückgabetyp ändert sich -> vorher droppen)
drop function if exists public.table_status(uuid);
create or replace function public.table_status(p_event uuid)
returns table(id uuid, name text, min_consumption numeric, capacity int, sort int, taken boolean)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, t.min_consumption, t.capacity, t.sort,
    exists (select 1 from table_reservations r where r.table_id = t.id and r.status = 'reserviert') as taken
  from event_tables t
  where t.event_id = p_event and t.active
  order by t.sort, t.name;
$$;
grant execute on function public.table_status(uuid) to anon, authenticated;

-- Ticketcode-Generator (VIP-Freitickets)
create or replace function public.gen_ticket_code() returns text
language sql volatile as $$
  select 'FX-' || upper(substr(md5(gen_random_uuid()::text), 1, 4))
             || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4));
$$;

-- Tisch reservieren + Freitickets ausstellen (atomar, exklusiv)
drop function if exists public.reserve_table(uuid, text, text, int, jsonb);
create or replace function public.reserve_table(
  p_table uuid, p_guest_name text, p_phone text, p_qty int, p_drinks jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      text := lower(coalesce(auth.jwt()->>'email',''));
  t       event_tables;
  ev      events;
  v_total numeric := 0;
  d       jsonb;
  v_res   uuid;
  v_order text;
  v_qty   int;
  i       int;
begin
  if me = '' then raise exception 'Bitte zuerst anmelden.'; end if;
  select * into t from event_tables where id = p_table and active;
  if not found then raise exception 'Tisch nicht verfügbar.'; end if;
  v_qty := greatest(1, least(coalesce(p_qty, 1), t.capacity));
  select * into ev from events where id = t.event_id;

  if p_drinks is not null then
    for d in select * from jsonb_array_elements(p_drinks) loop
      v_total := v_total + coalesce((d->>'price')::numeric, 0) * coalesce((d->>'qty')::int, 0);
    end loop;
  end if;

  -- Reservierung zuerst -> Exklusivitätsprüfung (unique index) schlägt sonst hier fehl
  insert into table_reservations
    (event_id, table_id, email, guest_name, phone, party_size, min_consumption, drinks, drinks_total)
  values
    (t.event_id, t.id, me, nullif(p_guest_name,''), nullif(p_phone,''), v_qty,
     t.min_consumption, coalesce(p_drinks, '[]'::jsonb), v_total)
  returning id into v_res;

  -- Kostenlose Bestellung + Tickets
  v_order := 'VIP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into orders (id, email, status, total, paid_via, paid_at, event_id)
    values (v_order, me, 'bezahlt', 0, 'vip-tisch', now(), t.event_id);
  insert into order_items (order_id, category_id, event_name, category_name, price, qty)
    values (v_order, null, ev.name, 'VIP-Tisch: ' || t.name, 0, v_qty);
  for i in 1..v_qty loop
    insert into tickets (code, order_id, category_id, event_name, event_date, event_location, category_name, price)
      values (gen_ticket_code(), v_order, null, ev.name, ev.date, ev.location, 'VIP-Tisch: ' || t.name, 0);
  end loop;

  update table_reservations set order_id = v_order where id = v_res;

  return jsonb_build_object('id', v_res, 'table', t.name, 'tickets', v_qty, 'order', v_order);
exception when unique_violation then
  raise exception 'Dieser Tisch wurde soeben reserviert. Bitte wähle einen anderen.';
end $$;
grant execute on function public.reserve_table(uuid, text, text, int, jsonb) to authenticated;

-- Reservierung stornieren (Owner) -> auch die Freitickets ungültig machen
create or replace function public.cancel_table_reservation(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r table_reservations;
begin
  select * into r from table_reservations where id = p_id;
  if not found then raise exception 'Reservierung nicht gefunden.'; end if;
  if not owns_event_id(r.event_id) then raise exception 'Keine Berechtigung.'; end if;
  update table_reservations set status = 'storniert' where id = p_id;
  if r.order_id is not null then update orders set status = 'storniert' where id = r.order_id; end if;
end $$;
grant execute on function public.cancel_table_reservation(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
