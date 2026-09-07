-- ============================================================
-- Multi-Mandanten – Phase 1b: RLS & Admin-Funktionen mandantenfähig
-- Veranstalter (organizer) sehen/verwalten nur ihre eigenen Events;
-- Head-Admin (super_admin) sieht/verwaltet alles. Öffentliche Reads
-- (aktive Events/Kategorien, Sitzplan) und Kunden-Reads (eigene
-- Bestellungen/Tickets per E-Mail) bleiben unverändert.
-- ============================================================
begin;

-- Besitzt der aktuelle Nutzer das Event mit dieser ID? (super_admin ODER owner)
create or replace function public.owns_event_id(p_event uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select public.is_super_admin()
     or exists(select 1 from events e
               where e.id = p_event
                 and e.owner_email = lower(coalesce(auth.jwt()->>'email',''))) $$;
grant execute on function public.owns_event_id(uuid) to anon, authenticated;

-- ---------- events ----------
drop policy if exists events_read on public.events;
create policy events_read on public.events for select
  using (active or owns_event(owner_email));
drop policy if exists events_admin on public.events;
create policy events_admin on public.events for all
  using (owns_event(owner_email)) with check (owns_event(owner_email));

-- ---------- categories ----------
drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select
  using ((active and exists(select 1 from events e where e.id = event_id and e.active))
         or owns_event_id(event_id));
drop policy if exists categories_admin on public.categories;
create policy categories_admin on public.categories for all
  using (owns_event_id(event_id)) with check (owns_event_id(event_id));

-- ---------- orders ----------
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select
  using (lower(email) = lower(coalesce(auth.jwt()->>'email',''))
         or owns_event_id(event_id));
drop policy if exists orders_admin on public.orders;
create policy orders_admin on public.orders for update
  using (owns_event_id(event_id)) with check (owns_event_id(event_id));

-- ---------- order_items ----------
drop policy if exists items_read on public.order_items;
create policy items_read on public.order_items for select
  using (exists(select 1 from orders o where o.id = order_id
           and (lower(o.email) = lower(coalesce(auth.jwt()->>'email',''))
                or owns_event_id(o.event_id))));
drop policy if exists order_items_admin on public.order_items;
create policy order_items_admin on public.order_items for all
  using (exists(select 1 from orders o where o.id = order_id and owns_event_id(o.event_id)))
  with check (exists(select 1 from orders o where o.id = order_id and owns_event_id(o.event_id)));

-- ---------- tickets ----------
drop policy if exists tickets_read on public.tickets;
create policy tickets_read on public.tickets for select
  using (exists(select 1 from orders o where o.id = order_id
           and (lower(o.email) = lower(coalesce(auth.jwt()->>'email',''))
                or owns_event_id(o.event_id))));
drop policy if exists tickets_admin on public.tickets;
create policy tickets_admin on public.tickets for update
  using (exists(select 1 from orders o where o.id = order_id and owns_event_id(o.event_id)))
  with check (exists(select 1 from orders o where o.id = order_id and owns_event_id(o.event_id)));

-- ---------- seats (öffentliches Lesen bleibt; Verwaltung nach Event-Besitz) ----------
drop policy if exists seats_admin on public.seats;
create policy seats_admin on public.seats for all
  using (owns_event_id(event_id)) with check (owns_event_id(event_id));

-- ---------- settings & admins: nur Head-Admin ----------
drop policy if exists settings_admin on public.settings;
create policy settings_admin on public.settings for all
  using (is_super_admin()) with check (is_super_admin());
drop policy if exists admins_admin on public.admins;
create policy admins_admin on public.admins for all
  using (is_super_admin()) with check (is_super_admin());

-- ---------- Admin-Funktionen mandantenfähig ----------
create or replace function public.check_in_ticket(p_code text) returns json
language plpgsql security definer set search_path = public as $fn$
declare t tickets; o orders; s seats; seatxt text := null;
begin
  select * into t from tickets where code = upper(trim(p_code));
  if not found then raise exception 'Ticketcode nicht gefunden.'; end if;
  select * into o from orders where id = t.order_id;
  if not owns_event_id(o.event_id) then raise exception 'Keine Berechtigung für dieses Event.'; end if;
  if o.status = 'storniert' then raise exception 'Bestellung wurde storniert – Ticket ungültig.'; end if;
  if o.status <> 'bezahlt' then raise exception 'Bestellung % ist noch nicht bezahlt – Ticket nicht gültig.', o.id; end if;
  if t.checked_in then raise exception 'Ticket wurde bereits eingecheckt (%).', to_char(t.checked_in_at,'DD.MM.YYYY HH24:MI'); end if;
  if t.seat_id is not null then
    select * into s from seats where id = t.seat_id;
    if found then seatxt := 'Reihe '||s.row_no||' · Tisch '||s.table_no||' · Platz '||s.seat_no; end if;
  end if;
  update tickets set checked_in = true, checked_in_at = now() where code = t.code;
  return json_build_object('code', t.code, 'category', t.category_name, 'event', t.event_name, 'email', o.email, 'seat', seatxt);
end $fn$;

create or replace function public.admin_seat_map(p_event uuid)
returns table(id uuid, row_no integer, table_no integer, seat_no integer, status text, ticket_code text, guest_email text, checked_in boolean)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not owns_event_id(p_event) then raise exception 'Keine Berechtigung für dieses Event.'; end if;
  return query
  select s.id, s.row_no, s.table_no, s.seat_no,
    case
      when t.code is not null then 'sold'
      when exists(select 1 from seat_holds h where h.seat_id = s.id and h.expires_at > now()) then 'held'
      else 'free'
    end as status,
    t.code, o.email, coalesce(t.checked_in, false)
  from seats s
  left join tickets t on t.seat_id = s.id
    and exists(select 1 from orders oo where oo.id = t.order_id and oo.status <> 'storniert')
  left join orders o on o.id = t.order_id
  where s.event_id = p_event
  order by s.row_no, s.table_no, s.seat_no;
end $fn$;

create or replace function public.admin_move_seat(p_from uuid, p_to uuid) returns json
language plpgsql security definer set search_path = public as $fn$
declare ev_from uuid; ev_to uuid; t_from tickets; t_to tickets;
begin
  if p_from = p_to then raise exception 'Quelle und Ziel sind derselbe Platz.'; end if;
  select event_id into ev_from from seats where id = p_from;
  select event_id into ev_to from seats where id = p_to;
  if ev_from is null or ev_to is null then raise exception 'Sitzplatz nicht gefunden.'; end if;
  if ev_from <> ev_to then raise exception 'Plätze gehören zu verschiedenen Events.'; end if;
  if not owns_event_id(ev_from) then raise exception 'Keine Berechtigung für dieses Event.'; end if;

  select t.* into t_from from tickets t
    join orders o on o.id = t.order_id and o.status <> 'storniert'
    where t.seat_id = p_from;
  if t_from.code is null then raise exception 'Auf dem Quellplatz sitzt niemand.'; end if;

  if exists(select 1 from seat_holds h where h.seat_id = p_to and h.expires_at > now()) then
    raise exception 'Zielplatz ist gerade durch einen laufenden Kauf reserviert.';
  end if;

  select t.* into t_to from tickets t
    join orders o on o.id = t.order_id and o.status <> 'storniert'
    where t.seat_id = p_to;

  if t_to.code is not null then
    update tickets set seat_id = null where code = t_from.code;
    update tickets set seat_id = p_from where code = t_to.code;
    update tickets set seat_id = p_to where code = t_from.code;
    return json_build_object('action','swap','moved',t_from.code,'swapped_with',t_to.code);
  else
    update tickets set seat_id = p_to where code = t_from.code;
    return json_build_object('action','move','moved',t_from.code);
  end if;
end $fn$;

notify pgrst, 'reload schema';
commit;
