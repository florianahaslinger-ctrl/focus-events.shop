-- Gesamtkontingent pro Event (modular, an/abschaltbar).
-- NULL = aus (pro-Kategorie-Kontingent gilt), Zahl >= 0 = an (gemeinsamer Topf).
alter table public.events
  add column if not exists shared_quota integer
  check (shared_quota is null or shared_quota >= 0);

comment on column public.events.shared_quota is
  'Gemeinsames Ticket-Gesamtkontingent ueber alle Kategorien. NULL = deaktiviert (pro-Kategorie-quota gilt).';

-- Verkaufte Menge je Event (Gegenstueck zu category_sold), fuer die Topf-Berechnung.
create or replace view public.event_sold as
  select o.event_id,
         coalesce(sum(oi.qty), 0)::int as sold
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
   where o.status <> 'storniert'
     and o.event_id is not null
   group by o.event_id;

grant select on public.event_sold to anon, authenticated, service_role;
