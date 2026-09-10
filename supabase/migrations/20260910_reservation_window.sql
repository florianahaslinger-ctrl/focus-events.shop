-- Verfügbarkeit: offene (nicht bezahlte) Bestellungen dürfen Kontingent nur
-- befristet reservieren. Bisher zählten sie dauerhaft -> abgebrochene Checkouts
-- blockierten Tickets für immer. Jetzt: bezahlt zählt immer, offen nur 30 Min.
-- Additiv/nicht brechend; gilt für CORE und Focus gleichermaßen (Verbesserung).
begin;

create or replace view public.category_sold as
  select oi.category_id,
         coalesce(sum(oi.qty), 0)::int as sold
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.status = 'bezahlt'
     or (o.status = 'offen' and o.created_at > now() - interval '30 minutes')
  group by oi.category_id;

create or replace view public.event_sold as
  select o.event_id,
         coalesce(sum(oi.qty), 0)::int as sold
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where o.event_id is not null
    and (o.status = 'bezahlt'
      or (o.status = 'offen' and o.created_at > now() - interval '30 minutes'))
  group by o.event_id;

-- Käufer kann seine EIGENE offene Bestellung sofort freigeben (Checkout-Abbruch).
create or replace function public.release_open_order(p_order text) returns void
language sql security definer set search_path = public as $$
  update public.orders set status = 'storniert'
   where id = p_order
     and status = 'offen'
     and lower(email) = lower(coalesce(auth.jwt()->>'email', ''));
$$;
grant execute on function public.release_open_order(text) to anon, authenticated;

commit;
