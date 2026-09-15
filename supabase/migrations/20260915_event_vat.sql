-- ============================================================
-- Focus Events – optionale MwSt-Ausweisung je Event
-- ------------------------------------------------------------
-- Der Veranstalter kann pro Event optional einen MwSt-Satz (%)
-- hinterlegen. NULL = keine MwSt ausweisen. Der Ticketpreis bleibt
-- brutto (inkl.); die MwSt wird im Checkout nur herausgerechnet
-- und ausgewiesen ("inkl. X % MwSt: € Y").
--
-- Additiv/nicht brechend. events wird mit CORE geteilt; CORE ignoriert
-- die Spalte (NULL).
-- ============================================================
begin;

alter table public.events add column if not exists vat_rate numeric(5,2)
  check (vat_rate is null or (vat_rate >= 0 and vat_rate <= 100));

notify pgrst, 'reload schema';
commit;
