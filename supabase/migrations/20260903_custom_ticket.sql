-- ============================================================
-- Eigenes Ticket-Design pro Event (einmalig für HLW Linz-Auhof)
-- ------------------------------------------------------------
-- Optional kann ein Event ein eigenes, ganzseitiges Ticket-Design
-- hinterlegen (Vorder- und Rückseite als Bild-Data-URLs). Ist das
-- Feld gesetzt, erzeugt der PDF-Generator das Ticket im Design des
-- Veranstalters und legt nur den individuellen QR-Code + Ticketcode
-- darüber. Ist es NULL, gilt die Standard-CORE-Ticketvorlage.
--
-- Additiv & nicht brechend. Die Daten werden über denselben Resolver
-- wie die Sponsor-Logos erst beim PDF-Download nachgeladen (nicht in
-- getEvents), damit der Shop-Payload schlank bleibt.
-- Form: { "front": "data:image/jpeg;base64,...", "back": "data:..." }
-- ============================================================
alter table public.events add column if not exists custom_ticket jsonb;

notify pgrst, 'reload schema';
