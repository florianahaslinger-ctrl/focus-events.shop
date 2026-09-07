# CORE Management – Ticketshop-Anleitung

## Überblick

Der Ticketshop ist ein vollwertiger Onlineshop mit zentraler Datenbank und echter Online-Zahlung:

| Seite | Zweck |
|---|---|
| `tickets.html` | Öffentlicher Shop (klassisches, dunkles Design): Tickets auswählen, Anmeldung per E-Mail-Verifizierung, Online-Zahlung über Stripe, eigene Tickets mit QR-Code ansehen und als PDF laden |
| `shop/` | **Weißer Ticketshop** (eigenes Projekt, helles Design im Stil moderner Ticketshops) – funktional identisch mit `tickets.html`, ersetzt ihn aber nicht; beide laufen parallel |
| `dashboard.html` | Adminbereich: Statistiken & Diagramme, Events & Ticketkategorien verwalten, Bestellungen, Check-in, Admin-Verwaltung |

**Architektur:**
- **Supabase** (Projekt „Ticketsystem“): zentrale Datenbank für Events, Kategorien, Bestellungen und Tickets;
  E-Mail-Login mit Verifizierung; Zugriffsschutz über Row Level Security.
- **Stripe Checkout:** Käufer:innen zahlen auf der sicheren Stripe-Bezahlseite (Kreditkarte, Apple Pay, Google Pay u. a.).
  Ein **Webhook bestätigt die Zahlung serverseitig** – erst dann werden die Tickets erzeugt und freigeschaltet.
  Fälschen der „Zahlung erfolgreich“-Rückkehr bringt nichts: ohne bestätigte Stripe-Zahlung gibt es keine Tickets.
- Der geheime Stripe-Schlüssel liegt ausschließlich in den Supabase-Edge-Functions (Server), niemals im öffentlichen Code.

## Weißer Ticketshop (`shop/`)

Der weiße Shop unter **core-management.at/shop/** ist ein eigenständiges Projekt (eigene Dateien:
`shop/index.html`, `shop/shop.css`, `shop/shop.js`) und kann alles, was der klassische Shop kann –
gleicher Login, gleiche Events, gleiche Sitzplatzwahl, gleiche Stripe-Zahlung, gleiche Tickets/PDFs.
Er nutzt dieselbe Datenschicht (`assets/store.js`) und dieselbe Supabase-Datenbank; Bestellungen aus
beiden Shops landen im selben Dashboard. Der klassische Shop (`tickets.html`) bleibt unverändert online.

Damit die Rückkehr von der Stripe-Bezahlseite wieder im weißen Shop landet, kennt die Edge Function
`create-checkout` jetzt einen optionalen Rückkehr-Pfad (Whitelist: `/tickets.html` oder `/shop/`;
ohne Angabe wie bisher `/tickets.html`).

**Nach dem Deployen einmalig prüfen/einrichten:**
1. Die aktualisierte Edge Function `create-checkout` in Supabase neu deployen
   (`supabase functions deploy create-checkout`). Bis dahin funktioniert der weiße Shop trotzdem –
   die Rückkehr nach der Zahlung landet nur auf `tickets.html`; die Tickets sind in beiden Shops sichtbar.
2. In Supabase unter *Authentication → URL Configuration → Redirect URLs* zusätzlich
   `https://core-management.at/shop/` und `https://core-management.at/shop/index.html` eintragen,
   damit der Anmelde-Link aus der E-Mail zurück in den weißen Shop führt.

## Kaufablauf

1. Tickets auf `tickets.html` wählen → *Zur Kassa*.
2. E-Mail-Adresse eingeben → Supabase sendet eine Anmelde-E-Mail (Link anklicken oder Code eingeben).
3. *Weiter zur Online-Zahlung* → Stripe-Bezahlseite → zahlen.
4. Automatische Rückkehr in den Shop: Tickets sind sofort gültig – mit **QR-Code + klassischem Ticketcode**
   und **PDF-Download** (eine Seite pro Ticket).
5. Abgebrochene Zahlungen erzeugen keine Tickets; die Bestellung bleibt als „offen“ sichtbar und kann einfach neu ausgelöst werden.

## Dashboard

Anmeldung mit einer **Admin-E-Mail-Adresse** (gleicher Login-Flow). Wer Admin ist, steht in der Datenbank –
verwaltbar im Dashboard unter *Einstellungen → Admins verwalten*. Erster Admin: `florian.a.haslinger@gmail.com`.

- **Übersicht:** Umsatz (nur bezahlte Bestellungen), verkaufte Tickets, Check-in-Quote; Diagramme; Auslastung je Kategorie.
- **Events & Tickets:** vollständig modular – Events und Kategorien anlegen, Preise/Kontingente ändern, aktivieren/deaktivieren, löschen.
- **Bestellungen:** suchen/filtern, CSV-Export, Tickets-PDF, stornieren (Kontingent wird frei; Rückerstattung im Stripe-Dashboard).
- **Check-in:** drei Wege, alle gleichwertig:
  1. **QR-Scanner im Dashboard** (Tab *Check-in* → „Kamera-Scan starten“): Handy/Laptop-Kamera scannt die Tickets, der Check-in passiert automatisch (mit Vibration als Rückmeldung am Handy).
  2. **Handy-Kamera direkt:** Der QR-Code auf jedem Ticket öffnet `ticket.html` mit der Gültigkeitsprüfung (Gültig / bereits eingecheckt / nicht bezahlt / storniert). Ist man im selben Browser als Admin angemeldet, erscheint dort ein „Jetzt einchecken“-Knopf.
  3. **Manuelle Eingabe** des Ticketcodes (CM-XXXX-XXXX).

  Unbezahlte, stornierte oder bereits entwertete Tickets werden immer abgewiesen; jede Entwertung ist einmalig.

## Sitzplätze (nur für „Sitzkarten“)

Optional kann **eine** Ticketkategorie Sitzplätze bekommen; alle anderen bleiben Stehkarten ohne Platzwahl.

**Einrichten (Dashboard → Events & Tickets → Event bearbeiten):**
1. Bei der gewünschten Kategorie das Häkchen **„Sitzkarte“** setzen (nur eine Kategorie pro Event möglich) und speichern.
2. Im selben Dialog erscheint der Bereich **„Sitzplan“**: **Reihen**, **Tische pro Reihe** und **Sitze pro Tisch** eingeben und **„Sitzplan erstellen“**. Beispiel Ball: 5 Reihen × 10 Tische × 6 Sitze = 300 Plätze. Alles frei einstellbar.
3. Der Plan kann geleert/neu erstellt werden, solange noch keine Plätze verkauft sind.

**Kauf durch Familien:** Beim Kauf einer Sitzkarte öffnet sich der Sitzplan; die Familie klickt genau so viele freie Plätze an, wie sie Tickets kauft (z. B. 6 Plätze an einem Tisch, um zusammenzusitzen). Die Plätze werden **30 Minuten reserviert** und erst nach bestätigter Zahlung fest zugewiesen – doppelte Belegung ist ausgeschlossen. Der Sitzplatz steht danach auf dem Ticket, im PDF, in der Ticketprüfung und beim Check-in (Reihe · Tisch · Platz).

Vom Admin ausgestellte Sitzkarten (Tab „Tickets ausstellen“) bekommen automatisch die nächsten freien Plätze zugewiesen.

## Wichtig für den echten Betrieb

1. **E-Mail-Versand (eingerichtet ✓):** Anmelde-Codes werden über **Brevo** verschickt – nicht mehr über den
   begrenzten Supabase-Standardversand. Umgesetzt als *Send Email Hook*: Supabase ruft für jede Auth-E-Mail die
   Edge Function `send-auth-email` auf, die die Mail über die Brevo-API (HTTPS) mit deutscher Vorlage und
   6-stelligem Code verschickt. Absender: `office@core-management.at` (in Brevo verifiziert). Das 2-Mails-pro-Stunde-Limit
   entfällt damit; das Auth-Rate-Limit steht auf 100/Stunde. Brevos Gratis-Kontingent sind 300 Mails/Tag – bei größeren
   Verkaufswellen ggf. Brevo-Tarif prüfen.
2. **Stripe:** Auszahlungen, Rückerstattungen und Belege im Stripe-Dashboard (dashboard.stripe.com).
   Bei jeder Zahlung steht die Bestellnummer als *client_reference_id*.
3. **Schlüssel geheim halten:** Der `sk_live_…`-Schlüssel (Stripe), der `xkeysib-…`-Schlüssel (Brevo) und das
   Supabase-Access-Token gehören nirgendwo in den Code oder in Chats. Alle liegen als Secrets in Supabase
   (*Edge Functions → Secrets*: `STRIPE_SECRET_KEY`, `BREVO_API_KEY`). Nach Weitergabe rotieren und dort neu setzen;
   das Brevo-Konto-Passwort ggf. ändern.
4. Der im Frontend sichtbare Supabase-„anon“-Schlüssel ist **öffentlich vorgesehen** und durch Row Level Security abgesichert.

## Technische Komponenten

- `assets/store.js` – Datenschicht (Supabase-Client, Auth, Bestellungen, Admin-Funktionen)
- `assets/shop.js` / `assets/dashboard.js` – Seitenlogik
- `assets/supabase.js` – Supabase-JavaScript-Client (lokal eingebunden)
- `assets/qrcode.js` – QR-Code-Generator (MIT-Lizenz, lokal)
- `assets/ticket-pdf.js` – PDF-Erzeugung ohne externe Bibliotheken
- Supabase Edge Functions: `create-checkout` (legt Bestellung + Stripe-Session an, prüft Kontingente serverseitig),
  `stripe-webhook` (prüft die Stripe-Signatur, erzeugt Tickets nach bestätigter Zahlung),
  `send-auth-email` (Send Email Hook: verschickt Anmelde-Codes über Brevo, prüft die Standard-Webhooks-Signatur)
- Stripe-Webhook: `checkout.session.completed` → `https://xfdiuhmgkdujbjhdhvcw.supabase.co/functions/v1/stripe-webhook`
