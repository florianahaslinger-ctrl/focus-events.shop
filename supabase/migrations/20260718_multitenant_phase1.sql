-- ============================================================
-- Multi-Mandanten – Phase 1 (Grundlagen, additiv & nicht brechend)
-- Ziel: Mehrere Veranstalter im selben System; jeder sieht nur
-- seinen Ball, der Head-Admin (super_admin) sieht alles.
-- Dieser Schritt legt nur Spalten/Funktionen an und ändert noch
-- KEINE bestehenden RLS-Policies (Shop läuft unverändert weiter).
-- ============================================================

-- Besitzer (Veranstalter) je Event – E-Mail des Organizers
alter table public.events add column if not exists owner_email text;

-- Bestellung eindeutig einem Event zuordnen (für Mandanten-Scoping
-- und getrennte Auszahlungen; wird von create-checkout gesetzt)
alter table public.orders add column if not exists event_id uuid
  references public.events(id) on delete set null;

-- Rolle je Admin-Eintrag: 'super_admin' (Head-Admin) oder 'organizer'
alter table public.admins add column if not exists role text not null default 'super_admin';
alter table public.admins drop constraint if exists admins_role_chk;
alter table public.admins add constraint admins_role_chk check (role in ('super_admin','organizer'));

-- Head-Admin sicherstellen
update public.admins set role = 'super_admin' where email = 'florian.a.haslinger@gmail.com';
insert into public.admins (email, role) values ('florian.a.haslinger@gmail.com','super_admin')
  on conflict (email) do update set role = 'super_admin';

-- Super-Admin-Check (sieht/kann alles)
create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from admins a
     where a.email = lower(coalesce(auth.jwt()->>'email','')) and a.role = 'super_admin'
   ) $$;

-- Darf der aktuelle Nutzer dieses Event verwalten?
-- (Super-Admin ODER Veranstalter = Eigentümer des Events)
create or replace function public.owns_event(p_owner text) returns boolean
language sql stable security definer set search_path = public as
$$ select public.is_super_admin()
       or (p_owner is not null and p_owner = lower(coalesce(auth.jwt()->>'email',''))) $$;

grant execute on function public.is_super_admin() to anon, authenticated;
grant execute on function public.owns_event(text) to anon, authenticated;

notify pgrst, 'reload schema';
