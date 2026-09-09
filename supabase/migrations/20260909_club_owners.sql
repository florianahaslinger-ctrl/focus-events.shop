-- ============================================================
-- Club-Veranstalter (bis zu 5 pro Club, dauerhaft, Verwaltungszugriff)
-- Additiv & nicht brechend: CORE-Events haben club = NULL und sind
-- daher NIE betroffen. Auszahlung bleibt über EIN Stripe-Konto (owner_email).
-- ============================================================
begin;

create table if not exists public.club_owners (
  club     text not null,
  email    text not null,
  added_at timestamptz not null default now(),
  primary key (club, email)
);
create index if not exists club_owners_email_idx on public.club_owners (email);
alter table public.club_owners enable row level security;

-- Max. 5 Veranstalter je Club erzwingen
create or replace function public.club_owners_limit() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.club_owners where club = NEW.club) >= 5 then
    raise exception 'Maximal 5 Veranstalter pro Club (%).', NEW.club;
  end if;
  return NEW;
end $$;
drop trigger if exists club_owners_max5 on public.club_owners;
create trigger club_owners_max5 before insert on public.club_owners
  for each row execute function public.club_owners_limit();

-- Ist der aktuelle Nutzer Veranstalter dieses Clubs? (security definer -> keine RLS-Rekursion)
create or replace function public.is_club_owner(p_club text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_club is not null and exists(
    select 1 from public.club_owners c
    where c.club = p_club
      and c.email = lower(coalesce(auth.jwt()->>'email',''))
  ) $$;
grant execute on function public.is_club_owner(text) to anon, authenticated;

-- Ist der Nutzer Club-Veranstalter des Clubs DIESES Events?
create or replace function public.is_club_owner_of_event(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.events e
    where e.id = p_event and e.club is not null and public.is_club_owner(e.club)
  ) $$;
grant execute on function public.is_club_owner_of_event(uuid) to anon, authenticated;

-- owns_event_id ADDITIV erweitern (nur eine zusätzliche OR-Bedingung).
-- CORE-Events (club = NULL) => is_club_owner_of_event immer false => identisches Verhalten.
create or replace function public.owns_event_id(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
     or exists(select 1 from events e
               where e.id = p_event
                 and e.owner_email = lower(coalesce(auth.jwt()->>'email','')))
     or public.is_event_coowner(p_event)
     or public.is_club_owner_of_event(p_event) $$;
grant execute on function public.owns_event_id(uuid) to anon, authenticated;

-- RLS auf club_owners: lesen = Head-Admin oder Mitglied desselben Clubs; schreiben = nur Head-Admin
drop policy if exists club_owners_read on public.club_owners;
create policy club_owners_read on public.club_owners for select
  using (public.is_super_admin() or public.is_club_owner(club));

drop policy if exists club_owners_write on public.club_owners;
create policy club_owners_write on public.club_owners for all
  using (public.is_super_admin()) with check (public.is_super_admin());

commit;
