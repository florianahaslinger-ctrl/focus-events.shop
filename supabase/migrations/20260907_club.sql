-- Club-Zuordnung je Focus-Event (für die zwei Shop-Reiter LEVEL / YPSILON).
-- NULL = keinem Club zugeordnet. Nur für storefront='focus' relevant; CORE ignoriert die Spalte.
alter table public.events
  add column if not exists club text;

create index if not exists events_club_idx on public.events (club);

comment on column public.events.club is
  'Club/Location eines Focus-Events: ''LEVEL'' oder ''YPSILON'' (steuert die Shop-Reiter). NULL = CORE/ohne.';
