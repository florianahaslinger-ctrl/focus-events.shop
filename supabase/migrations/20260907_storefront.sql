-- Storefront-Trennung für mehrere gebrandete Shops auf EINEM Backend.
-- Focus Events teilt sich das CORE-Backend, soll aber nur eigene Events zeigen.
--
--   storefront = NULL     -> CORE (Bälle) – unverändertes Standardverhalten
--   storefront = 'focus'  -> Focus Events (Clubs LEVEL / YPSILON)
--
-- Additiv & nicht-destruktiv: CORE bleibt komplett unberührt (Spalte ist nullable,
-- CORE-Code setzt/liest sie nicht). Rückgängig: alter table ... drop column storefront;

alter table public.events
  add column if not exists storefront text;

-- Schnellzugriff für die gefilterte Shop-Abfrage (WHERE storefront = 'focus').
create index if not exists events_storefront_idx
  on public.events (storefront);

comment on column public.events.storefront is
  'Gebrandeter Shop, zu dem das Event gehört. NULL = CORE (Bälle), ''focus'' = Focus Events (Clubs).';
