-- CORE Management Ticketshop – Supabase-Schema
create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  date timestamptz,
  location text,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  price numeric(10,2) not null check (price >= 0),
  quota int not null default 0 check (quota >= 0),
  max_per_order int not null default 10,
  description text,
  active boolean not null default true,
  sort int not null default 0
);

create table if not exists public.orders (
  id text primary key,
  email text not null,
  status text not null default 'offen' check (status in ('offen','bezahlt','storniert')),
  total numeric(10,2) not null default 0,
  paid_via text,
  paid_at timestamptz,
  stripe_session_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(id) on delete cascade,
  category_id uuid references public.categories(id),
  event_name text not null,
  category_name text not null,
  price numeric(10,2) not null,
  qty int not null check (qty > 0)
);

create table if not exists public.tickets (
  code text primary key,
  order_id text not null references public.orders(id) on delete cascade,
  category_id uuid,
  event_name text not null,
  event_date timestamptz,
  event_location text,
  category_name text not null,
  price numeric(10,2) not null,
  checked_in boolean not null default false,
  checked_in_at timestamptz
);

create table if not exists public.admins (
  email text primary key
);

-- Admin-Prüfung (security definer, damit RLS-Policies sie nutzen können)
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from admins where email = lower(coalesce(auth.jwt()->>'email',''))) $$;

-- Verfügbarkeit je Kategorie (öffentlich lesbar, ohne Bestelldaten preiszugeben)
create or replace view public.category_sold
with (security_invoker = off) as
select oi.category_id, coalesce(sum(oi.qty),0)::int as sold
from order_items oi join orders o on o.id = oi.order_id
where o.status <> 'storniert'
group by oi.category_id;

grant select on public.category_sold to anon, authenticated;

-- RLS
alter table public.events enable row level security;
alter table public.categories enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.tickets enable row level security;
alter table public.admins enable row level security;

drop policy if exists events_read on public.events;
create policy events_read on public.events for select using (active or is_admin());
drop policy if exists events_admin on public.events;
create policy events_admin on public.events for all using (is_admin()) with check (is_admin());

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select
  using (active and exists (select 1 from events e where e.id = event_id and e.active) or is_admin());
drop policy if exists categories_admin on public.categories;
create policy categories_admin on public.categories for all using (is_admin()) with check (is_admin());

drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select
  using (email = lower(coalesce(auth.jwt()->>'email','')) or is_admin());
drop policy if exists orders_admin on public.orders;
create policy orders_admin on public.orders for update using (is_admin()) with check (is_admin());

drop policy if exists items_read on public.order_items;
create policy items_read on public.order_items for select
  using (exists (select 1 from orders o where o.id = order_id
         and (o.email = lower(coalesce(auth.jwt()->>'email','')) or is_admin())));

drop policy if exists tickets_read on public.tickets;
create policy tickets_read on public.tickets for select
  using (exists (select 1 from orders o where o.id = order_id
         and (o.email = lower(coalesce(auth.jwt()->>'email','')) or is_admin())));
drop policy if exists tickets_admin on public.tickets;
create policy tickets_admin on public.tickets for update using (is_admin()) with check (is_admin());

drop policy if exists admins_self on public.admins;
create policy admins_self on public.admins for select
  using (email = lower(coalesce(auth.jwt()->>'email','')));

-- Check-in als RPC (nur Admins), atomar und mit klaren Fehlermeldungen
create or replace function public.check_in_ticket(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare t tickets; o orders;
begin
  if not is_admin() then raise exception 'Nur für Admins.'; end if;
  select * into t from tickets where code = upper(trim(p_code));
  if not found then raise exception 'Ticketcode nicht gefunden.'; end if;
  select * into o from orders where id = t.order_id;
  if o.status = 'storniert' then raise exception 'Bestellung wurde storniert – Ticket ungültig.'; end if;
  if o.status <> 'bezahlt' then raise exception 'Bestellung % ist noch nicht bezahlt – Ticket nicht gültig.', o.id; end if;
  if t.checked_in then raise exception 'Ticket wurde bereits eingecheckt (%).', to_char(t.checked_in_at,'DD.MM.YYYY HH24:MI'); end if;
  update tickets set checked_in = true, checked_in_at = now() where code = t.code;
  return json_build_object('code', t.code, 'category', t.category_name, 'event', t.event_name, 'email', o.email);
end $$;

-- Admin einrichten
insert into public.admins (email) values ('florian.a.haslinger@gmail.com') on conflict do nothing;

-- Demo-Event nur anlegen, wenn noch keine Events existieren
do $$
declare eid uuid;
begin
  if not exists (select 1 from events) then
    insert into events (name, date, location, description, active)
    values ('Schulball 2026 – Grand Opening', '2026-11-14 20:00+01', 'Palais Eventsaal, Wien',
            'Der große Ball des Jahres – Live-Band, DJ, Mitternachtseinlage.', true)
    returning id into eid;
    insert into categories (event_id, name, price, quota, max_per_order, description, sort) values
      (eid, 'Standard', 25, 400, 10, 'Regulärer Balleintritt', 1),
      (eid, 'VIP', 59, 60, 6, 'VIP-Bereich, Welcome-Drink, eigene Garderobe', 2),
      (eid, 'Schüler:innen ermäßigt', 18, 250, 10, 'Nur mit gültigem Schülerausweis', 3);
  end if;
end $$;

-- Nachträge (Teil des Live-Schemas)
alter table public.order_items drop constraint if exists order_items_category_id_fkey;
alter table public.order_items add constraint order_items_category_id_fkey
  foreign key (category_id) references public.categories(id) on delete set null;
alter table public.tickets drop constraint if exists tickets_category_id_fkey;
alter table public.tickets add constraint tickets_category_id_fkey
  foreign key (category_id) references public.categories(id) on delete set null;
drop policy if exists admins_admin on public.admins;
create policy admins_admin on public.admins for all using (is_admin()) with check (is_admin());
notify pgrst, 'reload schema';

-- ============================================================
-- Sitzplatz-System (nachträglich ergänzt)
-- ============================================================
-- Sitzplatz-System
alter table public.categories add column if not exists seating boolean not null default false;
alter table public.tickets add column if not exists seat_id uuid;

create table if not exists public.seats (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  row_no int not null,
  table_no int not null,
  seat_no int not null,
  created_at timestamptz not null default now(),
  unique(event_id, row_no, table_no, seat_no)
);
do $$ begin
  alter table public.tickets add constraint tickets_seat_fk foreign key (seat_id) references public.seats(id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists public.seat_holds (
  seat_id uuid primary key references public.seats(id) on delete cascade,
  order_id text not null references public.orders(id) on delete cascade,
  expires_at timestamptz not null
);

alter table public.seats enable row level security;
alter table public.seat_holds enable row level security;
drop policy if exists seats_read on public.seats;
create policy seats_read on public.seats for select using (true);
drop policy if exists seats_admin on public.seats;
create policy seats_admin on public.seats for all using (is_admin()) with check (is_admin());
-- seat_holds: kein öffentlicher Zugriff (nur Edge Functions via service_role)

-- Sitzplan mit Status (frei/reserviert/verkauft) – öffentlich lesbar, ohne Bestelldaten
create or replace function public.seat_map(p_event uuid)
returns table(id uuid, row_no int, table_no int, seat_no int, status text)
language sql stable security definer set search_path = public as $$
  select s.id, s.row_no, s.table_no, s.seat_no,
    case
      when exists(select 1 from tickets t join orders o on o.id = t.order_id
                  where t.seat_id = s.id and o.status <> 'storniert') then 'sold'
      when exists(select 1 from seat_holds h where h.seat_id = s.id and h.expires_at > now()) then 'held'
      else 'free'
    end as status
  from seats s where s.event_id = p_event
  order by s.row_no, s.table_no, s.seat_no;
$$;
grant execute on function public.seat_map(uuid) to anon, authenticated;

-- Plätze atomar reservieren (Edge Function): prüft frei, legt Holds an
create or replace function public.hold_seats(p_order text, p_seats uuid[], p_minutes int default 30)
returns void language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  delete from seat_holds where seat_id = any(p_seats) and expires_at < now();
  foreach sid in array p_seats loop
    if exists(select 1 from tickets t join orders o on o.id = t.order_id
              where t.seat_id = sid and o.status <> 'storniert') then
      raise exception 'Platz bereits verkauft';
    end if;
    if exists(select 1 from seat_holds where seat_id = sid) then
      raise exception 'Platz gerade reserviert – bitte anderen Platz wählen';
    end if;
  end loop;
  insert into seat_holds(seat_id, order_id, expires_at)
    select unnest(p_seats), p_order, now() + make_interval(mins => p_minutes);
end $$;

notify pgrst, 'reload schema';

-- Check-in & Ticketstatus inkl. Sitzplatz
create or replace function public.check_in_ticket(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare t tickets; o orders; s seats; seatxt text := null;
begin
  if not is_admin() then raise exception 'Nur für Admins.'; end if;
  select * into t from tickets where code = upper(trim(p_code));
  if not found then raise exception 'Ticketcode nicht gefunden.'; end if;
  select * into o from orders where id = t.order_id;
  if o.status = 'storniert' then raise exception 'Bestellung wurde storniert – Ticket ungültig.'; end if;
  if o.status <> 'bezahlt' then raise exception 'Bestellung % ist noch nicht bezahlt – Ticket nicht gültig.', o.id; end if;
  if t.checked_in then raise exception 'Ticket wurde bereits eingecheckt (%).', to_char(t.checked_in_at,'DD.MM.YYYY HH24:MI'); end if;
  if t.seat_id is not null then
    select * into s from seats where id = t.seat_id;
    if found then seatxt := 'Reihe '||s.row_no||' · Tisch '||s.table_no||' · Platz '||s.seat_no; end if;
  end if;
  update tickets set checked_in = true, checked_in_at = now() where code = t.code;
  return json_build_object('code', t.code, 'category', t.category_name, 'event', t.event_name, 'email', o.email, 'seat', seatxt);
end $$;

create or replace function public.ticket_status(p_code text)
returns json language plpgsql stable security definer set search_path = public as $$
declare t tickets; o orders; s seats; seatxt text := null;
begin
  select * into t from tickets where code = upper(trim(p_code));
  if not found then return json_build_object('found', false); end if;
  select * into o from orders where id = t.order_id;
  if t.seat_id is not null then
    select * into s from seats where id = t.seat_id;
    if found then seatxt := 'Reihe '||s.row_no||' · Tisch '||s.table_no||' · Platz '||s.seat_no; end if;
  end if;
  return json_build_object('found', true,
    'code', t.code, 'event', t.event_name, 'category', t.category_name,
    'event_date', t.event_date, 'event_location', t.event_location,
    'order_status', o.status, 'checked_in', t.checked_in, 'checked_in_at', t.checked_in_at, 'seat', seatxt);
end $$;
notify pgrst, 'reload schema';
