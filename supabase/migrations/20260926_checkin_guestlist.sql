-- ============================================================
-- Einlass-Scanner: Gästeliste per Event-Passwort
-- ------------------------------------------------------------
-- Das Türpersonal ist NICHT als Admin angemeldet, sondern nur per
-- Einlass-Passwort. Diese Funktion liefert ihm die Bestellungen des
-- EINEN Events, damit Gäste nach Namen gesucht und manuell
-- eingecheckt werden können (z. B. wenn der QR nicht lesbar ist).
--
-- Sicherheit: identisches Muster wie check_in_with_password –
-- Passwortprüfung gegen event_checkin, danach strikt auf p_event
-- eingeschränkt. Nur bezahlte Bestellungen, keine Fremd-Events.
-- ============================================================
begin;

create or replace function public.guest_list_with_password(p_event uuid, p_password text)
returns json language plpgsql security definer set search_path to 'public', 'extensions' as $fn$
declare h text; res json;
begin
  select password_hash into h from event_checkin where event_id = p_event;
  if h is null or h <> crypt(coalesce(p_password, ''), h) then
    raise exception 'Falsches Einlass-Passwort.';
  end if;

  select coalesce(json_agg(g order by g.name_sort, g.order_id), '[]'::json) into res
  from (
    select
      o.id                                as order_id,
      coalesce(o.customer_name, '')       as customer_name,
      lower(coalesce(o.customer_name, o.email)) as name_sort,
      o.email                             as email,
      count(t.code)::int                  as tickets_total,
      count(t.code) filter (where t.checked_in)::int as tickets_checked,
      json_agg(json_build_object(
        'code', t.code,
        'category', t.category_name,
        'checked_in', t.checked_in
      ) order by t.code)                  as tickets
    from orders o
    join tickets t on t.order_id = o.id
    where o.event_id = p_event
      and o.status = 'bezahlt'
    group by o.id, o.customer_name, o.email
  ) g;

  return res;
end $fn$;

grant execute on function public.guest_list_with_password(uuid, text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
