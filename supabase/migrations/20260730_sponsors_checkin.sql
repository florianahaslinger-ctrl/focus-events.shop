-- ============================================================
-- Sponsor-Logos pro Event + passwortgeschuetzter Einlass-Scanner
-- ============================================================

-- 1) Sponsor-Logos: Array von base64 data-URLs, oeffentlich (werden gedruckt).
alter table public.events
  add column if not exists sponsor_logos jsonb not null default '[]'::jsonb;

-- 2) Einlass-Passwort in SEPARATER Tabelle, damit der anon-Key den bcrypt-Hash
--    niemals lesen kann. Zugriff ausschliesslich ueber SECURITY-DEFINER-Funktionen.
create extension if not exists pgcrypto;

create table if not exists public.event_checkin (
  event_id uuid primary key references public.events(id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.event_checkin enable row level security;
-- Bewusst KEINE Policy: weder anon noch authenticated duerfen direkt zugreifen.
revoke all on public.event_checkin from anon, authenticated;

-- 3) Passwort setzen/aendern/entfernen (nur Event-Besitzer/Head-Admin).
create or replace function public.set_checkin_password(p_event uuid, p_password text)
returns void language plpgsql security definer set search_path to 'public', 'extensions' as $fn$
begin
  if not owns_event_id(p_event) then
    raise exception 'Keine Berechtigung fuer dieses Event.';
  end if;
  if p_password is null or length(trim(p_password)) = 0 then
    delete from event_checkin where event_id = p_event;
    return;
  end if;
  if length(trim(p_password)) < 4 then
    raise exception 'Das Einlass-Passwort muss mindestens 4 Zeichen haben.';
  end if;
  insert into event_checkin (event_id, password_hash, updated_at)
    values (p_event, crypt(trim(p_password), gen_salt('bf')), now())
  on conflict (event_id) do update
    set password_hash = excluded.password_hash, updated_at = now();
end $fn$;

-- 4) Status: ist ein Passwort gesetzt? (nur Besitzer)
create or replace function public.checkin_has_password(p_event uuid)
returns boolean language sql stable security definer set search_path to 'public' as $fn$
  select owns_event_id(p_event)
     and exists (select 1 from event_checkin where event_id = p_event);
$fn$;

-- 5) Passwort pruefen (anon) – fuer den Login auf der Einlass-Seite.
create or replace function public.verify_checkin_password(p_event uuid, p_password text)
returns json language plpgsql stable security definer set search_path to 'public', 'extensions' as $fn$
declare e public.events; h text;
begin
  select * into e from events where id = p_event;
  if not found then return json_build_object('ok', false); end if;
  select password_hash into h from event_checkin where event_id = p_event;
  if h is null then return json_build_object('ok', false, 'reason', 'disabled'); end if;
  if h = crypt(coalesce(p_password, ''), h) then
    return json_build_object('ok', true, 'event', e.name, 'date', e.date, 'location', e.location);
  end if;
  return json_build_object('ok', false);
end $fn$;

-- 6) Check-in per Passwort (anon), streng auf genau dieses Event begrenzt.
create or replace function public.check_in_with_password(p_event uuid, p_password text, p_code text)
returns json language plpgsql security definer set search_path to 'public', 'extensions' as $fn$
declare t public.tickets; o public.orders; s public.seats; h text; seatxt text := null;
begin
  select password_hash into h from event_checkin where event_id = p_event;
  if h is null or h <> crypt(coalesce(p_password, ''), h) then
    raise exception 'Falsches Einlass-Passwort.';
  end if;
  select * into t from tickets where code = upper(trim(p_code));
  if not found then raise exception 'Ticketcode nicht gefunden.'; end if;
  select * into o from orders where id = t.order_id;
  if o.event_id is distinct from p_event then
    raise exception 'Dieses Ticket gehoert nicht zu diesem Ball.';
  end if;
  if o.status = 'storniert' then raise exception 'Bestellung wurde storniert - Ticket ungueltig.'; end if;
  if o.status <> 'bezahlt' then raise exception 'Bestellung % ist noch nicht bezahlt - Ticket nicht gueltig.', o.id; end if;
  if t.checked_in then raise exception 'Ticket wurde bereits eingecheckt (%).', to_char(t.checked_in_at, 'DD.MM.YYYY HH24:MI'); end if;
  if t.seat_id is not null then
    select * into s from seats where id = t.seat_id;
    if found then seatxt := 'Reihe '||s.row_no||' - Tisch '||s.table_no||' - Platz '||s.seat_no; end if;
  end if;
  update tickets set checked_in = true, checked_in_at = now() where code = t.code;
  return json_build_object('code', t.code, 'category', t.category_name,
                           'event', t.event_name, 'email', o.email, 'seat', seatxt);
end $fn$;

grant execute on function public.set_checkin_password(uuid, text)    to authenticated;
grant execute on function public.checkin_has_password(uuid)          to authenticated;
grant execute on function public.verify_checkin_password(uuid, text) to anon, authenticated;
grant execute on function public.check_in_with_password(uuid, text, text) to anon, authenticated;
