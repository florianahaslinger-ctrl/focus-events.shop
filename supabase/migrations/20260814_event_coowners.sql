-- ============================================================
-- Mehrere Veranstalter pro Ball (Mit-Veranstalter / Co-Owner)
-- ------------------------------------------------------------
-- Ziel: Ein Ball hat weiterhin GENAU EINEN Haupt-Veranstalter
-- (events.owner_email) – nur dessen Stripe-Konto erhält die
-- Auszahlung (Destination Charge kann nur ein Zielkonto).
-- Zusätzlich können beliebig viele weitere Veranstalter-E-Mails
-- vollen Verwaltungs-/Ansichtszugriff auf denselben Ball bekommen
-- (Umsatz, Bestellungen, Einlass, Einstellungen) – OHNE Auszahlung.
--
-- Additiv & nicht brechend: bestehende Bälle behalten ihren
-- alleinigen Besitzer; die neue Tabelle ist standardmäßig leer.
-- ============================================================
begin;

-- Zuordnungstabelle: zusätzliche Veranstalter je Event.
-- Der Haupt-Veranstalter (events.owner_email) steht NICHT hier,
-- sondern bleibt wie bisher direkt am Event.
create table if not exists public.event_owners (
  event_id uuid not null references public.events(id) on delete cascade,
  email    text not null,
  added_at timestamptz not null default now(),
  primary key (event_id, email)
);
create index if not exists event_owners_email_idx on public.event_owners (email);

alter table public.event_owners enable row level security;

-- Ist der aktuelle Nutzer als Mit-Veranstalter dieses Events eingetragen?
create or replace function public.is_event_coowner(p_event uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from event_owners eo
     where eo.event_id = p_event
       and eo.email = lower(coalesce(auth.jwt()->>'email',''))
   ) $$;
grant execute on function public.is_event_coowner(uuid) to anon, authenticated;

-- Besitzt/verwaltet der aktuelle Nutzer dieses Event?
-- Jetzt: super_admin ODER Haupt-Veranstalter ODER Mit-Veranstalter.
-- Alle nachgelagerten Policies (categories/orders/tickets/seats) und
-- die Admin-Funktionen (check_in_ticket, admin_seat_map, admin_move_seat)
-- nutzen diese Funktion und werden dadurch automatisch mandantenfähig.
create or replace function public.owns_event_id(p_event uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select public.is_super_admin()
     or exists(select 1 from events e
               where e.id = p_event
                 and e.owner_email = lower(coalesce(auth.jwt()->>'email','')))
     or public.is_event_coowner(p_event) $$;
grant execute on function public.owns_event_id(uuid) to anon, authenticated;

-- ---------- events: Mit-Veranstalter dürfen lesen & bearbeiten ----------
-- Lesen: aktive Events sind öffentlich; sonst Besitzer, Mit-Veranstalter
-- oder Head-Admin.
drop policy if exists events_read on public.events;
create policy events_read on public.events for select
  using (active or owns_event(owner_email) or is_event_coowner(id));

-- Schreiben: getrennt nach Vorgang.
--  * INSERT: neue Bälle darf nur der spätere Haupt-Veranstalter (bzw. Head-
--    Admin) anlegen – geprüft am owner_email des NEUEN Datensatzes, da bei
--    INSERT noch keine Mit-Veranstalter existieren.
--  * UPDATE/DELETE: Besitzer, Mit-Veranstalter oder Head-Admin.
drop policy if exists events_admin on public.events;
drop policy if exists events_insert on public.events;
drop policy if exists events_modify on public.events;
drop policy if exists events_delete on public.events;
create policy events_insert on public.events for insert
  with check (owns_event(owner_email));
create policy events_modify on public.events for update
  using (owns_event_id(id)) with check (owns_event_id(id));
create policy events_delete on public.events for delete
  using (owns_event_id(id));

-- ---------- event_owners: Verwaltung durch Head-Admin bzw. Haupt-Veranstalter ----------
-- Lesen: jeder, der das Event verwaltet (Head-Admin, Haupt- oder Mit-Veranstalter).
-- Schreiben (zuweisen/entfernen): Head-Admin oder der Haupt-Veranstalter des
-- Events – NICHT die Mit-Veranstalter selbst (sonst könnten sie sich
-- gegenseitig entfernen oder Fremde hinzufügen).
drop policy if exists event_owners_read on public.event_owners;
create policy event_owners_read on public.event_owners for select
  using (owns_event_id(event_id));
drop policy if exists event_owners_admin on public.event_owners;
create policy event_owners_admin on public.event_owners for all
  using (
    is_super_admin()
    or exists(select 1 from events e
              where e.id = event_id
                and e.owner_email = lower(coalesce(auth.jwt()->>'email','')))
  )
  with check (
    is_super_admin()
    or exists(select 1 from events e
              where e.id = event_id
                and e.owner_email = lower(coalesce(auth.jwt()->>'email','')))
  );

notify pgrst, 'reload schema';
commit;
