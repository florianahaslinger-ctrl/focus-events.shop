# Focus Events – Ticketshop · Projekt-Übergabe (Stand: 08.09.2026)

> **Kurzfassung:** Eigenständiger Club-Ticketshop für die **Focus Events GmbH**
> (Clubs **LEVEL** & **YPSILON Heidenreichstein**). Rebrand des CORE-Shops mit
> **komplett eigenem Frontend**, **teilt sich aber das CORE-Backend** (dieselbe
> Supabase + Stripe). Eigene Domain **focus-events.shop**. Trennung von CORE über
> die Spalte `events.storefront`, Reiter LEVEL/YPSILON über `events.club`.
> **CORE bleibt komplett unangetastet.**
>
> Geheimnisse stehen **nicht** hier – der `sbp_`-Token liegt in `CORE-CREDENTIALS.txt`
> (eine Ebene höher, gemeinsam mit CORE genutzt).

---

## 0. Schnellstart

```bash
cd "C:/Users/pustl/OneDrive/Desktop/Claude/Focus-Events"
git status && git log --oneline -5
```

* **Lokaler Ordner:** `C:\Users\pustl\OneDrive\Desktop\Claude\Focus-Events`
* **Repo:** `florianahaslinger-ctrl/focus-events.shop` (öffentlich)
* **Branch:** `master`  ·  **aktueller Stand:** `66775fc`
* **Deploy-Flow:** committen → `git push origin master` → **GitHub Pages baut `master`** (Build ~1–2 Min)
* **Live:** **http://focus-events.shop** (HTTPS-Zertifikat wird noch ausgestellt – siehe §6)
* **GitHub CLI:** installiert unter `C:\Program Files\GitHub CLI\gh.exe`, eingeloggt als `florianahaslinger-ctrl`

---

## 1. Kernidee: ein Backend, zwei gebrandete Shops

CORE („Ticketsystem für Bälle") und Focus Events nutzen **dieselbe Supabase-DB und
dieselben Edge Functions**. Getrennt wird rein über zwei Spalten der Tabelle `events`:

| Spalte | Werte | Bedeutung |
|---|---|---|
| `events.storefront` | `NULL` = CORE · `'focus'` = Focus | welcher Shop das Event zeigt |
| `events.club` | `'LEVEL'` · `'YPSILON'` · `NULL` | welcher **Reiter** im Focus-Shop |

* Das **Focus-Frontend** (`assets/store.js`, Konstante `STOREFRONT='focus'`) filtert in
  `getEvents()` auf `storefront='focus'` **und** taggt neu angelegte Events automatisch damit.
* **CORE ist unverändert** – es setzt/liest `storefront` nicht (also `NULL`) und bleibt dadurch
  in seinem eigenen Shop unter sich.
* ⚠️ **Bekannte Einschränkung:** Da COREs Frontend **nicht** angefasst wurde, filtert es *nicht*
  auf storefront. CORE zeigt daher technisch weiterhin **alle** aktiven Events – auch die
  Focus-Events. Praktisch fällt das kaum auf (Focus wird nur über focus-events.shop beworben),
  aber wenn Focus-Events **nicht** im CORE-Shop auftauchen sollen, im CORE-Repo in
  `getEvents()` **eine Zeile** ergänzen: `.is('storefront', null)` (bzw. `storefront is null`).

---

## 2. Was in diesem Projekt gebaut wurde

### a) Rebrand CORE → Focus Events
* Farbe **Gold → Türkis `#079f96`** durchgängig (CSS/HTML/JS, inkl. Ticket-PDF-Akzent).
  Grün/Rot/Blau (Status/Charts) blieben erhalten.
* Marke überall **CORE Management → Focus Events**, Logo-Schriftzug **FOCUS · EVENTS**.
* **Favicon** aus dem „F"-Zeichen des Focus-Logos generiert (`favicon.png`).
* Logos unter `assets/img/`: `focus-logo.png`, `level-logo.png`, `ypsilon-logo.png`
  sowie **weiße Varianten** `level-logo-white.png` / `ypsilon-logo-white.png` fürs dunkle Theme.

### b) Shop = Startseite
* `index.html` **ist** der Shop (nicht mehr die CORE-SaaS-Marketingseite).
* `tickets.html` → **Redirect** auf `index.html` (alte Links funktionieren weiter).

### c) Eigenes Club-Design (bewusst NICHT wie CORE)
* Fonts **Anton** (Display/Headlines) + **Space Grotesk** (UI/Text) – statt CORE-Serif (Cormorant).
* Dunkler Hintergrund mit Türkis-Glow, Hero „**WÄHLE DEINEN CLUB.**".
* **Zwei große Reiter LEVEL / YPSILON** (mit weißen Club-Logos, Event-Zähler, aktiver Reiter
  leuchtet türkis). Event-Liste als **Grid** aus Cards (Datumsblock · Titel · Preise · Mengen-Stepper).
* Warenkorb, Login (E-Mail-OTP), Checkout (Stripe), Sitzplan, „Meine Tickets" – **unverändert
  übernommen** aus dem CORE-Shop, nur neu skiniert.

### d) Reiter-Logik
* `assets/shop.js`: `activeClub` (Default `LEVEL`), `setupClubTabs()`, gefiltertes `renderEvents()`.
* Direktlink auf ein einzelnes Event weiterhin via `?event=<ID>` (übersteuert die Reiter).

### e) Backend-Erweiterungen (auf der gemeinsamen CORE-Supabase, additiv)
* Migration `supabase/migrations/20260907_storefront.sql` → Spalte `events.storefront` (**live eingespielt**).
* Migration `supabase/migrations/20260907_club.sql` → Spalte `events.club` (**live eingespielt**).
* `assets/store.js`: lädt/mappt/speichert `club`; taggt Inserts mit `storefront='focus'`.
* `assets/dashboard.js` + `dashboard.html`: **Club-Dropdown** (LEVEL/YPSILON) im Event-Editor (`evClub`).

### f) Rechtstexte
* Impressum/Datenschutz/Cookie auf **Focus Events GmbH** umgestellt; die falschen CORE-Daten
  (Julius Jeitschko/Einzelunternehmen) wurden entfernt und durch klar markierte
  **`[wird ergänzt]`-Platzhalter** ersetzt (siehe offene To-dos §7).

---

## 3. Architektur

* **Frontend:** statisches HTML + Vanilla JS. Hosting **GitHub Pages** (`master`).
  `.nojekyll` muss im Root bleiben. `CNAME` enthält `focus-events.shop`.
* **Backend (geteilt mit CORE):** Supabase (Postgres + RLS, Edge Functions in Deno,
  Auth per E-Mail-OTP). Projekt „Ticketsystem", Ref `xfdiuhmgkdujbjhdhvcw`,
  URL `https://xfdiuhmgkdujbjhdhvcw.supabase.co` (steht in `assets/store.js`).
* **Zahlung:** Stripe Connect (Express) wie CORE – Destination Charges mit `application_fee`.
  Ein Event zahlt an das Stripe-Konto seines `owner_email` aus (Onboarding im Dashboard).
* **E-Mail:** Brevo (Send-Email-Hook, geteilt). Tickets kommen **nicht** als PDF-Anhang –
  das **PDF wird immer client-seitig** über `CMTicketPDF.download(order)` erzeugt.

---

## 4. Wichtige Dateien

| Datei | Zweck |
|---|---|
| `index.html` | **Shop = Startseite** (Club-Design, zwei Reiter) |
| `assets/shop.js` | Shop-Logik: Reiter, Rendering, Warenkorb, Checkout, „Meine Tickets" |
| `assets/store.js` | Datenschicht `CMStore`; **`STOREFRONT='focus'`**, `getEvents()`-Filter, `club`-Handling |
| `assets/dashboard.js` · `dashboard.html` | Admin-Dashboard; **Club-Dropdown** `evClub` |
| `assets/ticket-pdf.js` | PDF-Generator (Türkis-Akzent, QR auf `focus-events.shop/ticket.html`) |
| `ticket.html` · `einlass.html` | QR-Ziel bzw. Einlass-Scanner |
| `impressum.html` · `datenschutz.html` · `cookie-policy.html` | Rechtstexte (Platzhalter für Firmendaten) |
| `tickets.html` | Redirect → `index.html` |
| `assets/img/*.png` | Logos (+ weiße Varianten) |
| `favicon.png` | Focus-„F"-Favicon |
| `CNAME` | `focus-events.shop` (GitHub Pages Custom-Domain) |
| `supabase/migrations/20260907_storefront.sql` · `…_club.sql` | die zwei neuen Migrationen (live) |
| `tools/run-sql.sh` · `tools/apply-storefront-migration.sh` | SQL-/Migrations-Runner (in `.gitignore`, lesen Token aus `CORE-CREDENTIALS.txt`) |
| `README-FOCUS.md` | Kurzanleitung |

> `.gitignore` schließt `.claude/` und `tools/` aus (Helfer mit lokalem Pfad/Token-Zugriff bleiben lokal).

---

## 5. Kochrezepte (Git Bash)

**SQL / Migration auf dem gemeinsamen Backend ausführen** (Token wird aus `CORE-CREDENTIALS.txt` gelesen):
```bash
bash tools/run-sql.sh "alter table public.events add column if not exists foo int;"
# oder eine Datei:
bash tools/run-sql.sh --file supabase/migrations/DATEI.sql
```

**Deployen:**
```bash
git add -A
git commit -m "…"
git push origin master        # GitHub Pages baut danach master neu (~1–2 Min)
```
> `git push` funktioniert direkt. **`gh repo create` war durch den Sicherheits-Classifier
> geblockt** (Veröffentlichungs-Aktion) – das Repo wurde einmalig von Florian selbst per
> `gh repo create` im eigenen Terminal angelegt.

**Neues Event anlegen (LEVEL/YPSILON):** im `dashboard.html` einloggen (E-Mail-OTP),
Event anlegen und im **Club-Dropdown** LEVEL oder YPSILON wählen → erscheint automatisch im
richtigen Reiter (bekommt `storefront='focus'` + gewählten `club`).

**Edge-Function deployen** (identisch zu CORE, gleiches Projekt):
```bash
curl -s -X POST "https://api.supabase.com/v1/projects/xfdiuhmgkdujbjhdhvcw/functions/deploy?slug=create-checkout" \
  -H "Authorization: Bearer $SBP" -H "User-Agent: Mozilla/5.0 supabase-setup" \
  -F 'metadata={"entrypoint_path":"index.ts","verify_jwt":true};type=application/json' \
  -F "file=@supabase/functions/create-checkout/index.ts;type=application/typescript"
```

---

## 6. DNS & HTTPS

* **DNS (IONOS):** `focus-events.shop` (`@`) zeigt per **A-Records** auf GitHub Pages:
  `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
  (Der alte IONOS-Parking-A-Eintrag `217.160.0.22` + AAAA wurden entfernt.)
* **GitHub Pages:** aktiv, Quelle `master` / Root, Custom-Domain aus `CNAME`.
* **HTTPS:** Zertifikat wird von GitHub **automatisch** ausgestellt, sobald die Domain
  verifiziert ist (kann Minuten bis ~1 h dauern). Status prüfen / erzwingen:
  ```bash
  # Status:
  "/c/Program Files/GitHub CLI/gh.exe" api repos/florianahaslinger-ctrl/focus-events.shop/pages
  # Sobald "https_certificate.state" = approved/issued: HTTPS erzwingen
  "/c/Program Files/GitHub CLI/gh.exe" api -X PUT repos/florianahaslinger-ctrl/focus-events.shop/pages -F https_enforced=true
  ```

---

## 7. Offene To-dos

1. **HTTPS-Erzwingung** scharfschalten, sobald das Zertifikat ausgestellt ist (§6). Stand jetzt: noch nicht ausgestellt.
2. **Impressum-/Datenschutz-Firmendaten** eintragen (aktuell `[wird ergänzt]`-Platzhalter in
   `impressum.html`, `datenschutz.html`, `cookie-policy.html`):
   Anschrift · Firmenbuchnummer (FN…) + Firmenbuchgericht · UID (ATU…) · Geschäftsführer:in · Telefon.
   Kontakt-E-Mail steht aktuell als `office@focus-events.shop` – ggf. anpassen.
3. **Test-Events entfernen** (aktuell öffentlich sichtbar), sobald echte Events da sind. IDs:
   `11111111-1111-4111-8111-111111111111` (Neon Rave, LEVEL),
   `22222222-2222-4222-8222-222222222222` (90s & 2000s Night, LEVEL),
   `33333333-3333-4333-8333-333333333333` (YPSILON Clubbing, YPSILON).
   Löschen z. B.:
   ```bash
   bash tools/run-sql.sh "delete from public.events where id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333');"
   ```
4. **Stripe-Auszahlung:** Für echte Verkäufe muss der/die Veranstalter:in (der `owner_email`
   der Events) im Dashboard das eigene Stripe-Konto verbinden (Connect-Onboarding), sonst gehen
   die Zahlungen an das Plattform-Konto (Head-Admin).
5. **Textreste im Datenschutz** aus dem CORE-Kontext bereinigen (z. B. Kontaktformular-Absatz mit
   „Schule / Wunschtermin", Formspree) – im Focus-Shop nicht relevant.
6. Optional: echte Event-Bilder / Club-Fotos in die Cards, Social-Links, Google-Fonts lokal hosten (DSGVO).

---

## 8. Verifizierung (08.09.2026)

* Farb-/Namens-/Domain-Rebrand vollständig; keine Gold-Reste, keine `core-management.at`-Reste.
* Mandantentrennung getestet: Focus-Shop zeigt **nur** `storefront='focus'`; leerer Zustand korrekt,
  keine CORE-Bälle sichtbar.
* Reiter LEVEL/YPSILON getestet: Zähler (2 / 1), Umschalten filtert korrekt, Cards inkl. Kategorien/Preise.
* Beide Migrationen (`storefront`, `club`) live eingespielt (HTTP 201).
* Deploy live: `http://focus-events.shop` liefert das neue Club-Design (Marker `clubTabs`,
  `level-logo-white`, `Space Grotesk` bestätigt). HTTPS ausstehend.
