# Focus Events – Ticketshop · Projekt-Übergabe (Stand: 09.09.2026)

> **Kurzfassung:** Eigenständiger Club-Ticketshop der **Focus Events GmbH** (Clubs
> **LEVEL** & **YPSILON Heidenreichstein**). **Helles** Poster-Design mit Club-Farben
> (LEVEL blau, YPSILON magenta). **Teilt sich das CORE-Backend** (dieselbe Supabase +
> Stripe) – **CORE bleibt komplett unangetastet**. Hosting auf **Cloudflare Pages**,
> eigene Domain **focus-events.shop** + Subdomain je Club.
>
> Diese Datei ist die **eine** gültige Übergabe (die frühere dunkle Version und die
> separate Cowork-Datei wurden hier zusammengeführt). **Secrets stehen NICHT hier** (§9).

---

## 0. Schnellzugriff

* **Live:** https://focus-events.shop · Subdomains https://level.focus-events.shop · https://ypsilon.focus-events.shop (beide 200/HTTPS aktiv)
* **Dashboard:** https://focus-events.shop/dashboard.html (E-Mail-OTP-Login, nur Admins)
* **Hosting:** **Cloudflare Pages**, Projekt **`focus-events`** (Preview `focus-events.pages.dev`), aktuell **Direct Upload** aus `dist/` (noch nicht Git-verbunden – siehe §3).
* **DNS:** **Cloudflare** (Zone `focus-events.shop`). SSL/TLS-Modus **Full**.
* **Repo (Quelle der Wahrheit):** `florianahaslinger-ctrl/focus-events.shop` (öffentlich, Branch `master`).
* **Lokal:** `C:\Users\pustl\OneDrive\Desktop\Claude\Focus-Events`
* **Cloudflare-Account-ID:** `20fc99620b59a24f532c573355ee9c30`
* **Supabase-Projekt „Ticketsystem", Ref:** `xfdiuhmgkdujbjhdhvcw`
* **GitHub CLI:** `C:\Program Files\GitHub CLI\gh.exe`, eingeloggt als `florianahaslinger-ctrl`

---

## 1. Kernidee: ein Backend, mehrere gebrandete Shops

CORE („Bälle") und Focus Events teilen sich **dieselbe Supabase-DB + Edge Functions + Stripe**.
Getrennt wird über zwei Spalten der Tabelle `events`:

| Spalte | Werte | Bedeutung |
|---|---|---|
| `events.storefront` | `NULL` = CORE · `'focus'` = Focus | welcher Shop das Event zeigt |
| `events.club` | `'LEVEL'` · `'YPSILON'` · `NULL` | Reiter / Subdomain im Focus-Shop |

* Focus-Frontend (`assets/store.js`, `STOREFRONT='focus'`) filtert auf `storefront='focus'` und
  taggt neue Events automatisch.
* **CORE unverändert** (setzt/liest diese Spalten nicht → `NULL`).
* ⚠️ **Bekannte Einschränkung:** COREs Frontend filtert *nicht* auf storefront, zeigt also technisch
  weiter alle aktiven Events (auch Focus-Events). Falls unerwünscht: im CORE-Repo in `getEvents()`
  eine Zeile `.is('storefront', null)` ergänzen. (Bewusst offen gelassen.)

---

## 2. Design / Farbsystem (Cowork-Redesign, beibehalten)

* Helle Basis (`--bg #f4f2ec`, `--surface #fff`, `--ink #0f0f12`), Fonts **Anton** + **Space Grotesk**.
* **Club-Akzent** über `data-club` auf `<html>`: **LEVEL `#2b38f5`** (blau), **YPSILON `#ff1466`** (magenta).
  Die ganze Seite färbt sich je aktivem Club um. Technisch über Umbiegen der geteilten CORE-CSS-Variablen
  (`--gold*` etc.) im `<style>` von `index.html` → **CORE bleibt intakt, kein Türkis mehr auf dieser Seite**.
* Zwei **Club-Reiter** LEVEL/YPSILON (Logik `setupClubTabs`/`activeClub` in `assets/shop.js`).
* **Subdomain-Routing:** `clubFromHost()` + Schalter `const SUBDOMAINS_LIVE = true;` in `shop.js`.
  `level.`/`ypsilon.` laden direkt im jeweiligen Club; Klick auf den anderen Club springt auf dessen Subdomain.
* Dashboard-Akzent Türkis → **Focus-Blau** (Override-Block `id="fxDashTheme"` in `dashboard.html`, dunkel bleibt).

> Das **Favicon** ist noch das alte Türkis-„F" (`favicon.png`) – optional ans neue Design anpassen (§10).

---

## 3. Hosting & Deploy (Cloudflare Pages)

Cloudflare Pages ist **aktuell nicht mit Git verbunden** → Deploy per **Direct Upload** von `dist/`.

**`dist/` bauen** (Git-Bash; nur die Website, ohne `.git`, `tools/`, `.claude/`, `supabase/`):
```bash
cd "C:/Users/pustl/OneDrive/Desktop/Claude/Focus-Events"
rm -rf dist && mkdir dist
cp *.html favicon.png CNAME dist/ ; cp -r assets dist/ ; [ -d shop ] && cp -r shop dist/ ; touch dist/.nojekyll
```

**Deployen** (PowerShell; frisches, scoped Cloudflare-Token – siehe §9):
```powershell
cd "C:\Users\pustl\OneDrive\Desktop\Claude\Focus-Events"
$env:CLOUDFLARE_ACCOUNT_ID = "20fc99620b59a24f532c573355ee9c30"
$env:CLOUDFLARE_API_TOKEN = (Read-Host "Cloudflare-Token einfuegen").Trim()
npx --yes wrangler@latest pages deploy dist --project-name focus-events --branch master
```

**Empfehlung (offen):** Cloudflare Pages **mit dem GitHub-Repo verbinden** (Dashboard → Pages →
Projekt → Settings → Builds & deployments → Connect to Git; Branch `master`, Build command *leer*,
Output directory `/`). Dann deployt jeder `git push` automatisch – kein manuelles Direct-Upload mehr.

**Repo aktuell halten (immer!):**
```bash
git add -A && git commit -m "..." && git push origin master   # im Windows-Git-Bash (autocrlf)
```

---

## 4. DNS (Cloudflare)

Zone `focus-events.shop` auf Cloudflare. Relevante Records:

| Typ | Name | Ziel | Proxy |
|---|---|---|---|
| CNAME | `@` | `focus-events.pages.dev` | Proxied 🟠 |
| CNAME | `level` | `focus-events.pages.dev` | Proxied 🟠 |
| CNAME | `ypsilon` | `focus-events.pages.dev` | Proxied 🟠 |
| MX | `@` | `mx00.ionos.de` / `mx01.ionos.de` (Prio 10) | DNS only |
| TXT | `@` | `v=spf1 include:_spf-eu.ionos.com ~all` | DNS only |

* Alle Custom Domains im Pages-Projekt unter **Custom domains** eingetragen.
* **SSL/TLS-Modus der Zone = `Full`** (sonst Redirect-Loop mit Pages!).
* Alte GitHub-Pages-A-Records (`185.199.*`) am Apex entfernt. `www.` zeigt evtl. noch auf alte GitHub-IPs → optional aufräumen.

---

## 5. Datenbank / Migrations (geteilte Supabase, alle additiv, **alle eingespielt**)

| Datei | Inhalt | Status |
|---|---|---|
| `20260907_storefront.sql` | Spalte `events.storefront` (+Index) | ✅ eingespielt |
| `20260907_club.sql` | Spalte `events.club` (+Index) | ✅ eingespielt |
| `20260909_club_owners.sql` | Tabelle `club_owners` (max 5/Club), `is_club_owner`, `is_club_owner_of_event`, `owns_event_id` additiv erweitert, RLS | ✅ eingespielt (09.09.) |
| `20260909_event_image.sql` | Spalte `events.image_url` + Storage-Bucket `event-images` (public read, admin write) | ✅ eingespielt (09.09.) |

> **Korrektur ggü. Cowork-Handoff:** dort war behauptet, `club_owners` sei eingespielt und `event_image`
> offen – **tatsächlich war keine der beiden Migrationen in der DB**. Beide wurden am 09.09. verifiziert
> eingespielt (Tabelle/Spalte/Bucket/Funktionen bestätigt vorhanden).

**Migration einspielen** (Git-Bash, liest `sbp_`-Token aus `CORE-CREDENTIALS.txt`):
```bash
bash tools/run-sql.sh --file supabase/migrations/DATEI.sql
# oder beliebiges SQL:  bash tools/run-sql.sh "select 1;"
```
PowerShell-Alternative siehe frühere Doku; Git-Bash ist der einfachste Weg.

---

## 6. Features im Detail

**Club-Veranstalter** (`club_owners`): Head-Admin trägt im Dashboard → Einstellungen →
„Club-Veranstalter (LEVEL & YPSILON)" bis zu **5 E-Mails je Club** ein. Diese Personen verwalten nach
Login **alle** Events ihres Clubs (via `owns_event_id` → `is_club_owner_of_event`). Auszahlung bleibt
über das Stripe-Konto des jeweiligen Events. Datenschicht: `S.getClubOwners/addClubOwner/removeClubOwner`.

**Event-Bilder** (Banner je Event): Event-Editor → „Event-Bild" → Upload nach Supabase Storage
(`S.uploadEventImage`, Bucket `event-images`), URL in `events.image_url`, Anzeige als `.ev-banner` auf
der Card. `getEvents` ist **fehlertolerant** (läuft auch ohne die Spalte weiter).

**Reiter/Storefront:** siehe §1–2. **Club-Dropdown** im Event-Editor (`evClub`) setzt LEVEL/YPSILON.

---

## 7. Wichtige Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Shop = Startseite (helles Club-Design, Club-Theme + Subdomain-Script) |
| `assets/shop.js` | Reiter, Rendering, Warenkorb, Checkout, **Subdomain-Routing** (`SUBDOMAINS_LIVE`), Event-Banner |
| `assets/store.js` | Datenschicht `CMStore`: `getEvents`/`saveEvent`, `club`, `uploadEventImage`, Club-/Event-Owner |
| `dashboard.html` · `assets/dashboard.js` | Admin-Dashboard (Focus-Blau, Club-Veranstalter-UI, Event-Bild-Upload, Club-Dropdown) |
| `assets/shop.css` | **geteiltes** CORE-Stylesheet – wird nur per CSS-Variablen umgefärbt, **nicht CORE-spezifisch ändern** |
| `assets/ticket-pdf.js` | PDF-Tickets (QR auf `focus-events.shop/ticket.html`) |
| `ticket.html` · `einlass.html` | QR-Ziel / Einlass-Scanner |
| `impressum.html` · `datenschutz.html` · `cookie-policy.html` | Rechtstexte (Firmendaten noch Platzhalter, §10) |
| `supabase/migrations/*.sql` | 4 Migrationen (alle eingespielt, §5) |
| `tools/run-sql.sh` · `tools/apply-storefront-migration.sh` | SQL-/Migrations-Runner (in `.gitignore`, lesen Token aus `CORE-CREDENTIALS.txt`) |
| `dist/` | Deploy-Ordner für Cloudflare (in `.gitignore`) |
| `CNAME` | `focus-events.shop` |

---

## 8. Aktueller Stand & nächste Schritte

**Fertig & committet (`master`):** helles Redesign, Subdomains + HTTPS (Cloudflare), Dashboard-Blau,
Club-Veranstalter (Migration + UI), Event-Bilder (Migration + Upload + Banner) – alles im Repo,
`.gitignore` um `dist/`/`.wrangler/` ergänzt.

**Offen / dein Schritt:**
1. **Redeploy nötig:** Der aktuelle Live-Stand ist inkonsistent (Club-Veranstalter-UI live, aber
   `uploadEventImage`/`ev-banner` fehlten). `dist/` ist frisch gebaut → einmal deployen (§3), damit die
   Event-Bilder auch live funktionieren. **Ideal:** stattdessen Pages mit Git verbinden (§3).
2. **Cloudflare-Secrets rotieren** (§9) – dringend.
3. **Club-Veranstalter testen:** Dashboard → Einstellungen → LEVEL eine E-Mail hinzufügen → „1/5"?
4. **Event-Bild testen:** Event bearbeiten → Bild hochladen → speichern → Banner auf der Card.
5. **Punkt 4 – Dynamic Pricing (noch NICHT gebaut).** Spezifikation:
   * Preis-**Phasen pro Ticket-Kategorie** (Early Bird → Regular → Abendkasse).
   * Umschalten **per Datum**, **per verkaufter Menge** oder **manuell**.
   * Käufer sieht **aktuellen Preis + nächste Phase** (Countdown / „ab X verkauft").
   * **Serverseitige Preisberechnung** in der geteilten `create-checkout`-Edge-Function (additiv;
     CORE ohne Phasen exakt wie bisher), Test im **Stripe-Testmodus** vor Livegang.
   * Geplant: Tabelle `category_phases`, Editor im Dashboard, Anzeige im Shop.

---

## 9. Zugänge & Secrets — bewusst NICHT im Klartext

| Zugang | Wo / wie |
|---|---|
| Supabase `sbp_`-Token (DB-Migrationen) | Datei `CORE-CREDENTIALS.txt` (eine Ebene über dem Repo) |
| Supabase-URL/Anon-Key (öffentlich) | in `assets/store.js` bzw. `assets/supabase.js` |
| Cloudflare-API-Token (Deploy) | Cloudflare → My Profile → API Tokens **neu erzeugen**, scoped: **Account · Cloudflare Pages · Edit** + **Account · Account Settings · Read** |
| Cloudflare-Login | Account `office@core-management.at` (Passwort im Passwort-Manager) |
| Stripe | dashboard.stripe.com |

> **⚠️ DRINGENDES Sicherheits-To-do:** Laut Cowork-Handoff wurden in jener Session ein **Cloudflare
> Global API Key**, mehrere **`cfut_`-API-Tokens** und das **Cloudflare-Passwort im Klartext gepostet**.
> Diese **rotieren/widerrufen** (Cloudflare → My Profile → API Tokens; Passwort ändern). Für Deploys
> **nur ein scoped Pages-Token** verwenden – **niemals** den Global Key.

---

## 10. Backlog

1. **Punkt 4 – Dynamic Pricing** (§8).
2. **Impressum/Datenschutz** echte Firmendaten (aktuell `[wird ergänzt]`): Anschrift, FN + Firmenbuchgericht,
   UID (ATU…), Geschäftsführung, Telefon.
3. **Test-Events entfernen**, sobald echte da sind (IDs `111…`, `222…`, `333…`):
   `bash tools/run-sql.sh "delete from public.events where id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333');"`
4. **Stripe-Connect-Onboarding** je Veranstalter/Club für echte Auszahlungen.
5. CORE-Textreste im Datenschutz bereinigen (Kontaktformular „Schule/Wunschtermin", Formspree).
6. **Cloudflare Pages ↔ Git** verbinden (Auto-Deploy statt Direct Upload, §3).
7. Favicon vom Türkis-„F" aufs neue Design; `www.`-Subdomain sauber auf Pages; weitere Seiten (Ticket/Legal) optional ins helle Design.

---

## 11. Verifizierung (09.09.2026)

* DB-Status geprüft: `club_owners`, `events.image_url`, Bucket `event-images`, Funktionen `is_club_owner`/
  `is_club_owner_of_event`/`owns_event_id` **vorhanden** (alle 4 Migrationen eingespielt).
* Live: `focus-events.shop` + `level.`/`ypsilon.` liefern das helle Design (HTTPS aktiv, 200).
* Feature-Code (Club-Veranstalter, Event-Bilder) geprüft und mit den Migrationen konsistent; alles committet
  auf `master`. **Live-Redeploy für Event-Bilder noch ausstehend** (§8.1).
