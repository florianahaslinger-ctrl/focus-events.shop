-- ============================================================
-- Focus Events – VIP-Tisch: spezielles Ticket (QR) ausstellen
-- ------------------------------------------------------------
-- Bei jeder VIP-Tisch-Reservierung wird zusätzlich ein kostenloses
-- „VIP-Tisch"-Ticket mit QR-Code erzeugt (0-€-Order, status 'bezahlt').
-- Es erscheint unter „Meine Tickets" und ist am Einlass scanbar.
-- Storno der Reservierung storniert auch dieses Ticket
-- (cancel_table_reservation setzt die Order auf 'storniert').
-- ============================================================
begin;

create or replace function public.gen_ticket_code() returns text
language sql volatile as $$
  select 'FX-' || upper(substr(md5(gen_random_uuid()::text), 1, 4))
             || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4));
$$;

drop function if exists public.reserve_table(uuid, date, text, text, jsonb);
create or replace function public.reserve_table(
  p_table uuid, p_date date, p_guest_name text, p_phone text, p_drinks jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
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
  select * into t from event_tables where id = p_table and active;
  if not found then raise exception 'Tisch nicht verfügbar.'; end if;
  select * into ev from events where id = t.event_id;

  if p_drinks is not null then
    for d in select * from jsonb_array_elements(p_drinks) loop
      v_total := v_total + coalesce((d->>'price')::numeric, 0) * coalesce((d->>'qty')::int, 0);
    end loop;
  end if;

  -- Reservierung zuerst -> Exklusivität pro Tisch & Tag
  insert into table_reservations
    (event_id, table_id, email, guest_name, phone, res_date, min_consumption, drinks, drinks_total)
  values
    (t.event_id, t.id, me, nullif(p_guest_name,''), nullif(p_phone,''), p_date,
     t.min_consumption, coalesce(p_drinks, '[]'::jsonb), v_total)
  returning id into v_res;

  -- Spezielles VIP-Tisch-Ticket (QR) – kostenlos
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
end $$;
grant execute on function public.reserve_table(uuid, date, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
