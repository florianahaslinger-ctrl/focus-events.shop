-- ============================================================
-- Focus Events – VIP-Tisch: Korrektur des Modells
-- ------------------------------------------------------------
-- Der VIP-Tisch ist eine reine (kostenlose) RESERVIERUNG; der
-- Mindestkonsum wird vor Ort bezahlt. Der Tisch enthält KEINE
-- Tickets. Eintrittstickets werden separat online wie im normalen
-- Shop (Stripe) gekauft.
--
-- Daher: reserve_table stellt keine Freitickets mehr aus, sondern
-- legt nur die Reservierung an. (Rücknahme von 20260913_vip_tickets.)
-- ============================================================
begin;

create or replace function public.reserve_table(
  p_table uuid, p_guest_name text, p_phone text, p_qty int, p_drinks jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      text := lower(coalesce(auth.jwt()->>'email',''));
  t       event_tables;
  v_total numeric := 0;
  d       jsonb;
  v_res   uuid;
begin
  if me = '' then raise exception 'Bitte zuerst anmelden.'; end if;
  select * into t from event_tables where id = p_table and active;
  if not found then raise exception 'Tisch nicht verfügbar.'; end if;

  if p_drinks is not null then
    for d in select * from jsonb_array_elements(p_drinks) loop
      v_total := v_total + coalesce((d->>'price')::numeric, 0) * coalesce((d->>'qty')::int, 0);
    end loop;
  end if;

  -- p_qty wird nicht mehr verwendet (keine Freitickets). Tickets kauft der
  -- Gast separat über den normalen Checkout.
  insert into table_reservations
    (event_id, table_id, email, guest_name, phone, min_consumption, drinks, drinks_total)
  values
    (t.event_id, t.id, me, nullif(p_guest_name,''), nullif(p_phone,''),
     t.min_consumption, coalesce(p_drinks, '[]'::jsonb), v_total)
  returning id into v_res;

  return jsonb_build_object('id', v_res, 'table', t.name);
exception when unique_violation then
  raise exception 'Dieser Tisch wurde soeben reserviert. Bitte wähle einen anderen.';
end $$;

notify pgrst, 'reload schema';
commit;
