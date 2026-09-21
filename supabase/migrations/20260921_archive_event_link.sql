-- ============================================================
-- Focus Events – Event-Archiv: Verknüpfung zum Live-Event
-- ------------------------------------------------------------
-- Ermöglicht "Archivieren"-Button: Kennzahlen-Snapshot mit Bezug
-- auf das Event. Wird das Event später gelöscht, bleibt der
-- Archiveintrag erhalten (event_id -> NULL). Das Dashboard blendet
-- ein bereits archiviertes Live-Event aus der Auto-Liste aus, damit
-- es nicht doppelt erscheint. Additiv/nicht brechend.
-- ============================================================
begin;

alter table public.event_archive
  add column if not exists event_id uuid references public.events(id) on delete set null;
create index if not exists event_archive_event_idx on public.event_archive (event_id);

notify pgrst, 'reload schema';
commit;
