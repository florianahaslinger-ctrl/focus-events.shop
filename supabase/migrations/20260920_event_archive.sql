-- ============================================================
-- Focus Events – Event-Archiv
-- ------------------------------------------------------------
-- Speichert Kennzahlen vergangener Events dauerhaft, auch wenn das
-- Live-Event später gelöscht wird. Das Dashboard zeigt im Archiv
-- automatisch alle vergangenen Live-Events (Zahlen live berechnet)
-- PLUS die hier gespeicherten Einträge (z. B. bereits gelöschte Events).
--
-- Additiv/nicht brechend. Teilt sich die CORE-DB; storefront trennt.
-- ============================================================
begin;

create table if not exists public.event_archive (
  id            uuid primary key default gen_random_uuid(),
  storefront    text not null default 'focus',
  name          text not null,
  club          text,                              -- 'LEVEL' | 'YPSILON' | NULL
  event_date    date,
  capacity      int,                               -- Gesamtkontingent (falls bekannt)
  tickets_sold  int not null default 0,
  revenue       numeric(12,2) not null default 0,  -- bezahlter Umsatz
  checkins      int,
  vip_count     int,                               -- VIP-Tisch-Reservierungen
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists event_archive_date_idx on public.event_archive (event_date desc);

-- ---------------- RLS ----------------
-- Nur eingeloggte Veranstalter (Eintrag in admins) dürfen lesen/schreiben.
alter table public.event_archive enable row level security;
drop policy if exists event_archive_admin on public.event_archive;
create policy event_archive_admin on public.event_archive for all
  using (exists (select 1 from admins a
                 where a.email = lower(coalesce(auth.jwt()->>'email',''))))
  with check (exists (select 1 from admins a
                      where a.email = lower(coalesce(auth.jwt()->>'email',''))));

-- Bereits gelöschtes Test-/Reopening-Event als Archiveintrag ergänzen.
-- Verkaufszahlen sind nicht mehr wiederherstellbar (mit dem Event gelöscht).
insert into public.event_archive
  (storefront, name, club, event_date, capacity, tickets_sold, revenue, checkins, vip_count, notes)
select 'focus', '🪩🟣 REOPENING', 'YPSILON', date '2026-09-19', null, 0, 0, 0, 0,
       'Gelöschtes Event – ursprüngliche Verkaufszahlen nicht wiederherstellbar (mit dem Event entfernt).'
where not exists (
  select 1 from public.event_archive
  where name = '🪩🟣 REOPENING' and event_date = date '2026-09-19'
);

notify pgrst, 'reload schema';
commit;
