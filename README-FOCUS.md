# Focus Events – Ticketshop (Stand 07.09.2026)

Eigenständiges Projekt für **Focus Events GmbH** (Nachtclub-Ticketing, Clubs **LEVEL** & **YPSILON Heidenreichstein**).
Rebrand des CORE-Shops, **teilt sich aber das CORE-Backend** (dieselbe Supabase).

## Architektur
- **Frontend:** statisches HTML/Vanilla-JS, Türkis `#079f96` + Schwarz/Weiß. `index.html` = Shop (Startseite).
- **Backend:** gemeinsame CORE-Supabase (`xfdiuhmgkdujbjhdhvcw`), Stripe Connect wie CORE.
- **Mandantentrennung:** Spalte `events.storefront` – `NULL` = CORE (Bälle), `'focus'` = Focus (Clubs).
  Das Focus-Frontend filtert in `getEvents()` auf `storefront='focus'` und taggt neu angelegte Events automatisch damit (`assets/store.js`, Konstante `STOREFRONT`).

## Setup / Go-live
1. **Migration einspielen** (fügt `events.storefront` hinzu, additiv/nicht-destruktiv, CORE bleibt unberührt):
   ```bash
   bash Focus-Events/tools/apply-storefront-migration.sh
   ```
   Danach zeigt der Shop nur Focus-Events (anfangs leer, bis welche im Dashboard angelegt sind).
2. **Impressum/Datenschutz** auf Focus Events GmbH anpassen (`impressum.html`, `datenschutz.html`, `cookie-policy.html`) – aktuell stehen dort noch CORE-Rechtsdaten (Julius Jeitschko/Einzelunternehmen).
3. **Domain + Hosting:** eigenes GitHub-Repo + Pages + `CNAME`. Platzhalter-Domain aktuell `focus-events.at`.

## Events anlegen
Über `dashboard.html` mit einem Focus-Berechtigten (E-Mail-OTP-Login, gleiche Auth wie CORE).
Neu angelegte Events bekommen automatisch `storefront='focus'` und tauchen nur im Focus-Shop auf.
LEVEL / YPSILON werden als `location` gesetzt.
