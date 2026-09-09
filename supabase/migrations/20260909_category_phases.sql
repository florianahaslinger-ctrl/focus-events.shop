-- Dynamic Pricing: Preis-Phasen je Ticketkategorie (Early Bird -> Regular -> ...).
-- Additiv & nicht brechend: Kategorien mit pricing_mode='fixed' (Default) verhalten
-- sich exakt wie bisher; CORE ist damit unberührt.
begin;

alter table public.categories add column if not exists pricing_mode text not null default 'fixed';
alter table public.categories add column if not exists active_phase int;  -- NULL = automatisch, sonst manuell erzwungener Phasen-Index

create table if not exists public.category_phases (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  sort        int not null default 0,
  name        text not null,
  price       numeric(10,2) not null check (price >= 0),
  ends_at     timestamptz,                                   -- Datum-Trigger: Phase endet zu diesem Zeitpunkt
  ends_qty    int check (ends_qty is null or ends_qty >= 0)  -- Mengen-Trigger: Phase endet ab X kumuliert verkauften Tickets
);
create index if not exists category_phases_cat_idx on public.category_phases (category_id, sort);

alter table public.category_phases enable row level security;

-- Lesen: wenn die zugehörige Kategorie öffentlich lesbar ist (aktives Event) oder man das Event verwaltet.
drop policy if exists category_phases_read on public.category_phases;
create policy category_phases_read on public.category_phases for select
  using (exists(
    select 1 from public.categories c join public.events e on e.id = c.event_id
    where c.id = category_id and ((c.active and e.active) or public.owns_event_id(c.event_id))
  ));

-- Schreiben: nur wer das Event der Kategorie verwaltet (Head-Admin / Veranstalter / Club-Veranstalter).
drop policy if exists category_phases_write on public.category_phases;
create policy category_phases_write on public.category_phases for all
  using (exists(select 1 from public.categories c where c.id = category_id and public.owns_event_id(c.event_id)))
  with check (exists(select 1 from public.categories c where c.id = category_id and public.owns_event_id(c.event_id)));

commit;
