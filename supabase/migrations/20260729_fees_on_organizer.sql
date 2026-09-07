-- Gebuehren-Modus pro Event (modular): wer traegt Service- und Zahlungsgebuehr?
-- false (Standard) = Kunde zahlt die Gebuehren obendrauf.
-- true = Veranstalter uebernimmt beide Gebuehren, Kunde zahlt exakt den Ticketpreis.
alter table public.events
  add column if not exists fees_on_organizer boolean not null default false;

comment on column public.events.fees_on_organizer is
  'true = Veranstalter traegt Service- und Zahlungsgebuehr, Kunde zahlt exakt den Ticketpreis. false = Kunde zahlt Gebuehren obendrauf (Standard).';
