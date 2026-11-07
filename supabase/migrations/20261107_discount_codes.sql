-- ============================================================
-- Rabattcodes pro Event (Prozent-Rabatt auf die Ticketpreise)
-- ------------------------------------------------------------
-- * discount_codes: je Event beliebig viele Codes (Code eindeutig je Event,
--   Groß-/Kleinschreibung egal), Prozent 1–100, optional max. Einlösungen.
-- * Lesen/Schreiben nur für Verwalter des Events (owns_event_id) – Kunden
--   sehen die Codes NIE; sie prüfen einen eingegebenen Code nur über die
--   RPC check_discount_code (liefert nur den Prozentsatz zurück).
-- * Verbindlich angewendet wird der Rabatt ausschließlich serverseitig in
--   der Edge Function create-checkout (Service-Role).
-- * orders merkt sich Code, Prozent und Rabattbetrag (für Dashboard/Belege).
-- ============================================================
begin;

create table if not exists public.discount_codes (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  code        text not null check (length(btrim(code)) between 3 and 40),
  percent     numeric(5,2) not null check (percent > 0 and percent <= 100),
  max_uses    int check (max_uses is null or max_uses > 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  text
);
create unique index if not exists discount_codes_event_code_uq
  on public.discount_codes (event_id, upper(btrim(code)));

alter table public.discount_codes enable row level security;
drop policy if exists discount_codes_admin on public.discount_codes;
create policy discount_codes_admin on public.discount_codes for all
  using (public.owns_event_id(event_id))
  with check (public.owns_event_id(event_id));

alter table public.orders add column if not exists discount_code_id uuid references public.discount_codes(id) on delete set null;
alter table public.orders add column if not exists discount_code    text;
alter table public.orders add column if not exists discount_percent numeric(5,2);
alter table public.orders add column if not exists discount_amount  numeric(10,2);

-- Einlösungen zählen: bezahlte Bestellungen + gerade laufende Checkouts (offen, < 45 Min.)
create or replace function public.discount_code_used(p_code uuid) returns int
language sql stable security definer set search_path to 'public' as $$
  select count(*)::int from orders o
   where o.discount_code_id = p_code
     and (o.status = 'bezahlt' or (o.status = 'offen' and o.created_at > now() - interval '45 minutes'));
$$;
revoke all on function public.discount_code_used(uuid) from public, anon, authenticated;
grant execute on function public.discount_code_used(uuid) to service_role;

-- Shop: eingegebenen Code prüfen (nur Prozent + Gültigkeit, keine Codeliste)
create or replace function public.check_discount_code(p_event uuid, p_code text) returns json
language plpgsql stable security definer set search_path to 'public' as $$
declare d discount_codes%rowtype; v_used int;
begin
  if p_event is null or coalesce(btrim(p_code), '') = '' then
    return json_build_object('ok', false, 'error', 'Bitte einen Rabattcode eingeben.');
  end if;
  select * into d from discount_codes
   where event_id = p_event and upper(btrim(code)) = upper(btrim(p_code)) and active
   limit 1;
  if not found or not exists(select 1 from events e where e.id = p_event and e.active) then
    return json_build_object('ok', false, 'error', 'Dieser Rabattcode ist ungültig.');
  end if;
  if d.max_uses is not null then
    v_used := discount_code_used(d.id);
    if v_used >= d.max_uses then
      return json_build_object('ok', false, 'error', 'Dieser Rabattcode wurde bereits vollständig eingelöst.');
    end if;
  end if;
  return json_build_object('ok', true, 'code', upper(btrim(d.code)), 'percent', d.percent);
end $$;
grant execute on function public.check_discount_code(uuid, text) to anon, authenticated;

-- Dashboard: Einlösungen je Code eines Events (nur Verwalter)
create or replace function public.discount_code_stats(p_event uuid) returns table(id uuid, used int, amount numeric)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.owns_event_id(p_event) then raise exception 'Keine Berechtigung'; end if;
  return query
    select d.id,
           (select count(*)::int from orders o where o.discount_code_id = d.id and o.status = 'bezahlt'),
           coalesce((select sum(o.discount_amount) from orders o where o.discount_code_id = d.id and o.status = 'bezahlt'), 0)
      from discount_codes d where d.event_id = p_event;
end $$;
grant execute on function public.discount_code_stats(uuid) to authenticated;

commit;
