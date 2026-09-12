# Focus Events – Ticketshop · Projekt-Übergabe (Stand: 12.09.2026)

> **Kurzfassung:** Eigenständiger Club-Ticketshop der **Focus Events GmbH** (Clubs
> **LEVEL** & **YPSILON Heidenreichstein**). **Helles** Poster-Design mit Club-Farben
> (LEVEL blau `#2b38f5`, YPSILON magenta `#ff1466`). **Teilt sich das CORE-Backend**
> (dieselbe Supabase + Stripe) – **CORE bleibt eigenständig, wird nur minimal ergänzt**.
> Hosting auf **Cloudflare Pages (mit GitHub verbunden → Auto-Deploy bei Push)**,
> Domain **focus-events.shop** + Subdomain je Club.
>
> Secrets stehen **nicht** hier. `sbp_`-Supabase-Token: `CORE-CREDENTIALS.txt` (eine Ebene über dem Repo).

---

## 0. Schnellzugriff

* **Live:** https://focus-events.shop · https://level.focus-events.shop · https://ypsilon.focus-events.shop (HTTPS aktiv)
* **Dashboard:** https://focus-events.shop/dashboard.html (E-Mail-OTP-Login; Head-Admin: `florian.a.haslinger@gmail.com`)
* **Hosting:** **Cloudflare Pages**, Projekt `focus-events`, **mit GitHub-Repo verbunden** → **jeder `git push origin master` deployt automatisch**. (Kein manuelles Direct-Upload mehr nötig.)
* **DNS:** Cloudflare-Zone `focus-events.shop`, SSL-Modus **Full**. CNAMEs `@`/`level`/`ypsilon` → `focus-events.pages.dev`. MX weiter IONOS.
* **Repos (Quelle der Wahrheit):**
  * Focus: `florianahaslinger-ctrl/focus-events.shop` – Branch `master`, Stand `e815988`
  * CORE: `florianahaslinger-ctrl/Core-management.at` – Branch `main`, Stand `04d12ff` (GitHub Pages)
* **Lokal:** `C:\Users\pustl\OneDrive\Desktop\Claude\Focus-Events` (CORE daneben: `…\Core-management.at`)
* **Supabase-Projekt „Ticketsystem", Ref:** `xfdiuhmgkdujbjhdhvcw` · **Cloudflare-Account-ID:** `20fc99620b59a24f532c573355ee9c30`
* **GitHub CLI:** `C:\Program Files\GitHub CLI\gh.exe` (eingeloggt als florianahaslinger-ctrl)

---

## 1. Ein Backend, zwei getrennte Shops

CORE („Bälle") und Focus Events teilen sich **dieselbe Supabase-DB + Edge Functions + Stripe**.
Getrennt wird über zwei Spalten auf `events`:

| Spalte | Werte | Bedeutung |
|---|---|---|
| `events.storefront` | `NULL`=CORE · `'focus'`=Focus | welcher Shop das Event zeigt |
| `events.club` | `'LEVEL'` · `'YPSILON'` · `NULL` | Reiter/Subdomain im Focus-Shop |

* **Focus-Frontend** (`assets/store.js`, `STOREFRONT='focus'`) filtert/taggt auf `'focus'`.
* **CORE** filtert seit dieser Session `getEvents` mit `.is('storefront', null)` → zeigt **nur** Bälle, keine Club-Events. **Beide Richtungen sind sauber getrennt.**

---

## 2. Design

* Helle Basis (`--bg #f4f2ec`, `--surface #fff`, `--ink #0f0f12`), Fonts **Anton** (Headlines) + **Space Grotesk** (Text).
* **Club-Akzent** über `data-club` auf `<html>`: LEVEL blau, YPSILON magenta – die ganze Seite färbt sich je aktivem Club um (Umbiegen der geteilten CORE-CSS-Variablen im `<style>` von `index.html` → CORE bleibt intakt).
* Zwei **Club-Reiter** LEVEL/YPSILON; **Subdomain-Routing** (`shop.js`, `SUBDOMAINS_LIVE=true`, `clubFromHost()`).
* **Dashboard** im gleichen hellen Look (Override-Block `#fxDashTheme` in `dashboard.html`, inkl. Formularfelder/Nav/Kategorie-Zeile/Saalplan-Box aufgehellt – shop.css-Dunkeltöne überschrieben).

---

## 3. Deploy & Migrations

**Frontend deployen:** einfach committen + pushen – Cloudflare baut automatisch.
```bash
git add -A && git commit -m "…" && git push origin master   # Git-Bash (autocrlf)
```

**DB-Migration / SQL:** (liest `sbp_`-Token aus `CORE-CREDENTIALS.txt`)
```bash
bash tools/run-sql.sh --file supabase/migrations/DATEI.sql
bash tools/run-sql.sh "select 1;"
```

**Edge Function deployen (geteilt – muss Florian selbst ausführen, Classifier blockt den Assistenten):**
PowerShell:
```powershell
cd "C:\Users\pustl\OneDrive\Desktop\Claude\Focus-Events"
$cred = "C:\Users\pustl\OneDrive\Desktop\Claude\CORE-CREDENTIALS.txt"
$sbp = [regex]::Match((Get-Content $cred -Raw),'sbp_[A-Za-z0-9]+').Value
'{"entrypoint_path":"index.ts","verify_jwt":true}' | Out-File -Encoding ascii meta.json
curl.exe -s -X POST "https://api.supabase.com/v1/projects/xfdiuhmgkdujbjhdhvcw/functions/deploy?slug=create-checkout" -H "Authorization: Bearer $sbp" -H "User-Agent: supabase-setup" -F "metadata=@meta.json;type=application/json" -F "file=@supabase/functions/create-checkout/index.ts;type=application/typescript"
Remove-Item meta.json
```
> Frontend deployt automatisch; **Edge-Function-Änderungen brauchen diesen manuellen Deploy.** Nach jeder `create-checkout`-Änderung ausführen. `create-checkout` ist in **beiden** Repos synchron gehalten.

---

## 4. Was in dieser Session (09.–12.09.) gemacht wurde

1. **Cowork-Stand konsolidiert** – helles Design + Cloudflare beibehalten; halbfertige Features (Club-Veranstalter, Event-Bilder) sauber fertiggestellt, Migrationen tatsächlich eingespielt, alles committet.
2. **Harte Trennung** CORE↔Focus (CORE zeigt nur Bälle, Focus nur Club-Events).
3. **Dashboard** von „Ball"- auf **Club/Event-Sprache** umbenannt; **hell** wie der Shop; **Sitzplan-Reiter ausgeblendet**; **LEVEL/YPSILON-Auswahl prominent + Pflicht**.
4. **Checkout-Abbruch** führt zurück in den **Focus-Shop** (origin-Allowlist in `create-checkout`, rückwärtskompatibel für CORE inkl. Club-Subdomains).
5. **Mengen-Ziffer** im Stepper voll sichtbar (CSS-Fix).
6. **Dynamic Pricing** (Preis-Phasen je Kategorie) – siehe §5.
7. **Verfügbarkeit:** abgebrochene/offene Bestellungen blockieren Kontingent nicht mehr dauerhaft – siehe §6.
8. **Event-Kachel klickbar → Detail-/Großansicht** (großes Bild, volle Infos, Tickets mit Steppern).
9. **Focus-Logo als Platzhalter**, wenn ein Event kein eigenes Bild hat (Kachel + Detailansicht).
10. **Club-Veranstalter** sehen im Dashboard alle Events ihres Clubs (`getManagedEvents` ergänzt).
11. **Focus-Servicegebühr 0,1 %** ohne Fixbetrag/Ticket – siehe §7.

---

## 5. Dynamic Pricing (Preis-Phasen)

* Pro Ticketkategorie optional **Phasen** (Early Bird → Regular → Abendkasse). Jede Phase: Name, Preis, **Ende per Datum ODER Menge** (kumuliert verkauft); letzte Phase läuft bis Ausverkauf. **Manuelle Übersteuerung** möglich.
* **Aktive Phase** = erste noch nicht „vorbei"-Phase (identische Logik client- & serverseitig).
* **DB:** `category_phases` + `categories.pricing_mode`/`active_phase` (Migration `20260909_category_phases.sql`).
* **Code:** `store.js` `resolvePhaseIndex()` + effektiver Preis/`nextPhase`; `shop.js` Phasen-Badge + „Danach …"-Hinweis; `dashboard.js` Phasen-Editor je Kategorie (Add/Remove, Trigger, aktive Phase); `create-checkout` `effectiveUnitPrice()` (verbindlicher Server-Preis, additiv – CORE ohne Phasen unverändert).

---

## 6. Verfügbarkeit / Reservierung

* **Views `category_sold`/`event_sold`** zählen offene (nicht bezahlte) Bestellungen nur noch **30 Minuten** (bezahlte immer). Abgebrochene Checkouts geben das Kontingent so automatisch wieder frei. (Migration `20260910_reservation_window.sql`.)
* **Sofort-Freigabe bei Abbruch:** `shop.js` merkt die Order-ID (localStorage) und ruft bei Rückkehr mit `?cancelled=1` `release_open_order(p_order)` (SECURITY-DEFINER-RPC) → eigene offene Order wird sofort storniert, Verfügbarkeit neu geladen.

---

## 7. Gebühren

* **Servicegebühr (CORE-Anteil):** storefront-abhängig – **Focus = 0,1 %** (kein Fixbetrag/Ticket); **CORE-Bälle = 3,5 % + 0,25 €/Ticket** (unverändert). In `create-checkout` (`isFocus`) und in `store.js` `feeBreakdown`/`feeBreakdownLines`.
* **Zahlungsgebühr (Stripe):** weiterhin **1,5 % + 0,25 €/Ticket** (deckt Stripe-Kosten). *Offene Rückfrage:* ob die 0,25 €/Ticket hier auch entfallen soll.
* `application_fee` (Stripe Connect) = Service + Zahlung → bleibt bei der Plattform; Auszahlung an das Stripe-Konto des Event-`owner_email`.

---

## 8. Wichtige Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Shop = Startseite (helles Club-Design, Club-Theme + Subdomain-Script, Detail-Modal) |
| `assets/shop.js` | Reiter, Rendering, Warenkorb/Checkout, Subdomain-Routing, Dynamic-Pricing-Anzeige, Detail-Ansicht, Reservierungs-Freigabe |
| `assets/store.js` | Datenschicht `CMStore`: getEvents/saveEvent, Phasen, club, uploadEventImage, Club-/Event-Owner, feeBreakdown, releaseOpenOrder |
| `dashboard.html` · `assets/dashboard.js` | Admin-Dashboard (hell, Club/Event-Sprache, Phasen-Editor, Club-Veranstalter, Event-Bild-Upload) |
| `assets/shop.css` | **geteiltes** CORE-Stylesheet – nur per Variablen umgefärbt, **nicht** CORE-spezifisch ändern |
| `supabase/functions/create-checkout/index.ts` | Checkout: Server-Preis (Phasen), storefront-Gebühr, origin-Return, Reservierung. **In beiden Repos synchron.** |
| `supabase/migrations/*.sql` | u. a. `20260907_storefront`, `_club`, `20260909_category_phases`/`club_owners`/`event_image`, `20260910_reservation_window` (alle eingespielt) |
| `tools/run-sql.sh` · `tools/deploy-function.sh` | SQL-/Function-Helfer (in `.gitignore`, lesen Token aus `CORE-CREDENTIALS.txt`) |

---

## 9. Offene To-dos

1. **Impressum/Datenschutz** mit echten **Focus Events GmbH**-Daten füllen (aktuell Platzhalter `[wird ergänzt]`): Anschrift, FN + Firmenbuchgericht, UID (ATU…), Geschäftsführung, Telefon.
2. **Zahlungsgebühr:** klären, ob die 0,25 €/Ticket für Focus entfallen soll (§7).
3. Datenschutz-Textreste aus CORE-Kontext bereinigen (Formspree/„Schule/Wunschtermin").
4. Favicon vom Türkis-„F" aufs neue Design; Sitzplatz-Kachelfarben (falls VIP-Sitzpläne genutzt werden) noch CORE-dunkel; `www.`-Subdomain sauber auf Pages.
5. **Browser-Cache:** Assets sind nicht gehasht → nach JS-Deploys ggf. **Strg+F5** nötig.

---

## 10. Zugänge (nicht im Klartext)

| Zugang | Wo |
|---|---|
| Supabase `sbp_`-Token | `CORE-CREDENTIALS.txt` (eine Ebene über dem Repo) |
| Supabase URL/Anon-Key (öffentlich) | `assets/store.js` / `assets/supabase.js` |
| Cloudflare | Deploy läuft über Git-Anbindung (kein Token im Alltag nötig); Login `office@core-management.at` |
| Stripe | dashboard.stripe.com |

*Ende der Übergabe.*
