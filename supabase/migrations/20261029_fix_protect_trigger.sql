-- ============================================================
-- Fix: Loeschschutz-Trigger warf "record old has no field vip_club_default"
-- ------------------------------------------------------------
-- protect_vip_reservations() laeuft auf events UND event_tables. Die Pruefung
-- "Voreinstellung nicht loeschbar" griff auf old.vip_club_default zu – das Feld
-- gibt es nur bei events. PL/pgSQL wertet "a and b" nicht verkuerzt aus, daher
-- scheiterte seit 22.10.2026 jedes Loeschen eines Events mit Tischen (die Tische
-- werden per Cascade mitgeloescht) und jedes Entfernen eines Tisches.
-- Jetzt: Feldzugriff nur innerhalb des events-Zweigs.
-- ============================================================
begin;

create or replace function public.protect_vip_reservations()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare v_n int; v_dates text;
begin
  if tg_table_name = 'events' then
    if old.vip_club_default then
      raise exception 'Die VIP-Voreinstellung eines Clubs kann nicht gelöscht werden.';
    end if;
    select count(*), string_agg(distinct to_char(r.res_date, 'DD.MM.YYYY'), ', ')
      into v_n, v_dates
      from table_reservations r
     where r.status = 'reserviert' and r.res_date >= current_date and r.event_id = old.id;
  else
    select count(*), string_agg(distinct to_char(r.res_date, 'DD.MM.YYYY'), ', ')
      into v_n, v_dates
      from table_reservations r
     where r.status = 'reserviert' and r.res_date >= current_date and r.table_id = old.id;
  end if;
  if v_n > 0 then
    raise exception 'Nicht moeglich: % kommende VIP-Reservierung(en) (%) haengen daran. Bitte deaktivieren oder archivieren statt loeschen.', v_n, v_dates;
  end if;
  return old;
end $$;

commit;
