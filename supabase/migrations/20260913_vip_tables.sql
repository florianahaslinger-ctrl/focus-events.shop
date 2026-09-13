-- ============================================================
-- Focus Events – VIP-Tisch-Reservierung
-- ------------------------------------------------------------
-- Kunde wählt im Shop zwischen normalem Ticket und VIP-Tisch.
-- VIP = reine RESERVIERUNG (keine Online-Zahlung): Grundriss-Bild +
-- benannte Tische mit modularem Mindestkonsum; nach Tischwahl eine
-- ungefähre (unverbindliche) Getränke-Vorbestellung aus einer vom
-- Veranstalter hinterlegten Liste (Excel-Import: Name + Preis).
-- Buchung EXKLUSIV: ein Tisch = eine aktive Reservierung.
--
-- Additiv/nicht brechend. Teilt sich die CORE-DB; CORE-Events haben
-- vip_enabled=false und bleiben unberührt.
-- ============================================================
begin;

-- Event-Erweiterungen
alter table public.events add column if not exists vip_enabled boolean not null default false;
alter table public.events add column if not exists vip_floorplan_url text;     -- Grundriss-Bild
alter table public.events add column if not exists vip_info text;              -- optionaler Hinweistext

-- Tische je Event (Name + Mindestkonsum, modular im Dashboard)
create table if not exists public.event_tables (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  name            text not null,
  min_consumption numeric(10,2) not null default 0 check (min_consumption >= 0),
  sort            int  not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
create index if not exists event_tables_event_idx on public.event_tables (event_id);

-- Getränkeliste je Event (aus Excel: Name + Preis)
create table if not exists public.event_drinks (
  id        uuid primary key default gen_random_uuid(),
  event_id  uuid not null references public.events(id) on delete cascade,
  name      text not null,
  price     numeric(10,2) not null default 0 check (price >= 0),
  sort      int  not null default 0
);
create index if not exists event_drinks_event_idx on public.event_drinks (event_id);

-- Reservierungen (exklusiv, ohne Online-Zahlung)
create table if not exists public.table_reservations (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  table_id        uuid not null references public.event_tables(id) on delete cascade,
  email           text not null,
  guest_name      text,
  phone           text,
  party_size      int,
  min_consumption numeric(10,2) not null default 0,   -- Snapshot bei Reservierung
  drinks          jsonb not null default '[]'::jsonb, -- [{name,price,qty}] – unverbindlich
  drinks_total    numeric(10,2) not null default 0,   -- Summe der Vorbestellung (Info)
  status          text not null default 'reserviert' check (status in ('reserviert','storniert')),
  created_at      timestamptz not null default now()
);
-- Exklusiv: pro Tisch höchstens EINE aktive Reservierung
create unique index if not exists table_res_one_active
  on public.table_reservations (table_id) where status = 'reserviert';
create index if not exists table_res_event_idx on public.table_reservations (event_id);
create index if not exists table_res_email_idx on public.table_reservations (lower(email));

-- ---------------- RLS ----------------
alter table public.event_tables       enable row level security;
alter table public.event_drinks       enable row level security;
alter table public.table_reservations enable row level security;

-- Tische: öffentlich lesbar bei aktivem Event; verwalten nur Event-Owner
drop policy if exists event_tables_read on public.event_tables;
create policy event_tables_read on public.event_tables for select
  using ((active and exists (select 1 from events e where e.id = event_id and e.active))
         or owns_event_id(event_id));
drop policy if exists event_tables_admin on public.event_tables;
create policy event_tables_admin on public.event_tables for all
  using (owns_event_id(event_id)) with check (owns_event_id(event_id));

-- Getränke: dito
drop policy if exists event_drinks_read on public.event_drinks;
create policy event_drinks_read on public.event_drinks for select
  using (exists (select 1 from events e where e.id = event_id and e.active)
         or owns_event_id(event_id));
drop policy if exists event_drinks_admin on public.event_drinks;
create policy event_drinks_admin on public.event_drinks for all
  using (owns_event_id(event_id)) with check (owns_event_id(event_id));

-- Reservierungen: Kunde sieht seine eigenen; Owner sieht/verwaltet alle des Events.
-- Anlegen der Kunden-Reservierung NUR über reserve_table() (SECURITY DEFINER).
drop policy if exists table_res_read on public.table_reservations;
create policy table_res_read on public.table_reservations for select
  using (email = lower(coalesce(auth.jwt()->>'email','')) or owns_event_id(event_id));
drop policy if exists table_res_admin on public.table_reservations;
create policy table_res_admin on public.table_reservations for all
  using (owns_event_id(event_id)) with check (owns_event_id(event_id));

-- ---------------- Funktionen ----------------
-- Öffentlicher Tischstatus (frei/belegt), ohne Reservierungsdaten preiszugeben
create or replace function public.table_status(p_event uuid)
returns table(id uuid, name text, min_consumption numeric, sort int, taken boolean)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, t.min_consumption, t.sort,
    exists (select 1 from table_reservations r where r.table_id = t.id and r.status = 'reserviert') as taken
  from event_tables t
  where t.event_id = p_event and t.active
  order by t.sort, t.name;
$$;
grant execute on function public.table_status(uuid) to anon, authenticated;

-- Tisch reservieren (atomar, exklusiv). Kunde muss angemeldet sein.
create or replace function public.reserve_table(
  p_table uuid, p_guest_name text, p_phone text, p_party int, p_drinks jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      text := lower(coalesce(auth.jwt()->>'email',''));
  t       event_tables;
  v_total numeric := 0;
  d       jsonb;
  v_id    uuid;
begin
  if me = '' then raise exception 'Bitte zuerst anmelden.'; end if;
  select * into t from event_tables where id = p_table and active;
  if not found then raise exception 'Tisch nicht verfügbar.'; end if;

  if p_drinks is not null then
    for d in select * from jsonb_array_elements(p_drinks) loop
      v_total := v_total + coalesce((d->>'price')::numeric, 0) * coalesce((d->>'qty')::int, 0);
    end loop;
  end if;

  insert into table_reservations
    (event_id, table_id, email, guest_name, phone, party_size, min_consumption, drinks, drinks_total)
  values
    (t.event_id, t.id, me, nullif(p_guest_name,''), nullif(p_phone,''), p_party,
     t.min_consumption, coalesce(p_drinks, '[]'::jsonb), v_total)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'table', t.name);
exception when unique_violation then
  raise exception 'Dieser Tisch wurde soeben reserviert. Bitte wähle einen anderen.';
end $$;
grant execute on function public.reserve_table(uuid, text, text, int, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
