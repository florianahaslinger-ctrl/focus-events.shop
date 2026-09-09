/* =========================================================
   Focus Events Ticketshop – Datenschicht (store.js)
   Backend: Supabase (zentrale Datenbank, E-Mail-Login mit
   Verifizierung) + Stripe Checkout mit Webhook-Bestätigung.
   Der geheime Stripe-Schlüssel liegt NUR in den Supabase-
   Edge-Functions – niemals hier im Frontend.
   ========================================================= */
(function (global) {
  'use strict';

  const SUPA_URL = 'https://xfdiuhmgkdujbjhdhvcw.supabase.co';
  // Öffentlicher (anon) Schlüssel – durch Row Level Security abgesichert
  const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGl1aG1na2R1amJqaGRodmN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDI5MzUsImV4cCI6MjA5ODkxODkzNX0.HKKSNdNuIQXxh00LqvRFQciFMeF6oXrvvj-Gl9EaqmY';

  // Storefront-Kennung: Dieses Projekt (Focus Events) teilt sich das CORE-Backend,
  // zeigt/verwaltet aber ausschließlich Events mit events.storefront = 'focus'.
  // CORE selbst nutzt storefront = NULL und bleibt dadurch unberührt.
  const STOREFRONT = 'focus';

  let sb = null;          // Supabase-Client
  let session = null;     // aktuelle Auth-Session

  const fmtEUR = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });

  function normEmail(email) { return String(email || '').trim().toLowerCase(); }
  function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(email)); }

  function niceAuthError(e) {
    const m = (e && e.message) || String(e);
    if (/rate limit/i.test(m)) return 'E-Mail-Limit erreicht – bitte in einer Stunde erneut versuchen. (Tipp: eigenen SMTP-Server in Supabase hinterlegen, dann entfällt das Limit.)';
    if (/expired|invalid/i.test(m) && /token|otp/i.test(m)) return 'Der Code ist ungültig oder abgelaufen. Bitte neuen Code anfordern.';
    if (/security purposes/i.test(m)) return 'Bitte kurz warten – ein Code wurde gerade erst gesendet.';
    return m;
  }

  function mapOrder(o) {
    return {
      id: o.id, email: o.email, status: o.status, total: Number(o.total),
      paidVia: o.paid_via, paidAt: o.paid_at, createdAt: o.created_at, eventId: o.event_id || null,
      items: (o.order_items || []).map(i => ({
        categoryId: i.category_id, categoryName: i.category_name,
        eventName: i.event_name, price: Number(i.price), qty: i.qty
      })),
      tickets: (o.tickets || []).map(t => ({
        code: t.code, categoryId: t.category_id, categoryName: t.category_name,
        eventName: t.event_name, eventDate: t.event_date, eventLocation: t.event_location,
        price: Number(t.price), checkedIn: t.checked_in, checkedInAt: t.checked_in_at,
        seat: t.seats ? { row: t.seats.row_no, table: t.seats.table_no, seat: t.seats.seat_no } : null
      }))
    };
  }

  const ORDER_SELECT = 'id,email,status,total,paid_via,paid_at,created_at,event_id,' +
    'order_items(category_id,category_name,event_name,price,qty),' +
    'tickets(code,category_id,category_name,event_name,event_date,event_location,price,checked_in,checked_in_at,seats(row_no,table_no,seat_no))';

  const Store = {
    fmtEUR, validEmail, normEmail,

    /* --- Initialisierung & Auth --- */
    async init() {
      sb = supabase.createClient(SUPA_URL, SUPA_ANON);
      const { data } = await sb.auth.getSession();
      session = data.session;
      sb.auth.onAuthStateChange((_ev, s) => { session = s; });
      // Ticket-PDF: Sponsor-Logos je Event automatisch nachladen (falls PDF-Modul geladen).
      if (global.CMTicketPDF && typeof global.CMTicketPDF.setSponsorResolver === 'function') {
        global.CMTicketPDF.setSponsorResolver(id => Store.eventSponsorLogos(id));
      }
      // Ticket-PDF: eigenes Ticket-Design je Event nachladen (falls hinterlegt).
      if (global.CMTicketPDF && typeof global.CMTicketPDF.setCustomTicketResolver === 'function') {
        global.CMTicketPDF.setCustomTicketResolver(id => Store.eventCustomTicket(id));
      }
      return session;
    },
    client() { return sb; },
    currentUser() { return session && session.user ? normEmail(session.user.email) : null; },

    async requestCode(email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname }
      });
      if (error) throw new Error(niceAuthError(error));
      return { demo: false };
    },

    async verifyCode(email, code) {
      const token = String(code).replace(/\D/g, '');
      if (token.length < 6) throw new Error('Bitte gib den 6-stelligen Code aus der E-Mail ein.');
      const { data, error } = await sb.auth.verifyOtp({
        email: normEmail(email), token, type: 'email'
      });
      if (error) throw new Error(niceAuthError(error));
      session = data.session;
      return data.user;
    },

    async logout() { await sb.auth.signOut(); session = null; },

    /* --- Events & Verfügbarkeit --- */
    async getEvents(includeInactive) {
      const evCols = 'id,name,date,location,club,description,active,layout,owner_email,shared_quota,fees_on_organizer,sponsor_logos,event_owners(email),categories(id,name,price,quota,max_per_order,description,active,sort,seating)';
      let res = await sb.from('events').select(evCols + ',image_url').eq('storefront', STOREFRONT).order('date', { ascending: true });
      if (res.error && /image_url/i.test(res.error.message || '')) {
        res = await sb.from('events').select(evCols).eq('storefront', STOREFRONT).order('date', { ascending: true });
      }
      const { data, error } = res;
      if (error) throw new Error(error.message);
      const { data: sold } = await sb.from('category_sold').select('category_id,sold');
      const soldMap = {};
      (sold || []).forEach(s => { soldMap[s.category_id] = s.sold; });
      // Verkaufte Menge je Event – nur für Events mit Gesamtkontingent nötig.
      const { data: evSold } = await sb.from('event_sold').select('event_id,sold');
      const evSoldMap = {};
      (evSold || []).forEach(s => { evSoldMap[s.event_id] = s.sold; });
      return (data || [])
        .filter(e => includeInactive || e.active)
        .map(e => {
          // Gesamtkontingent: NULL = aus (pro-Kategorie), Zahl = an (gemeinsamer Topf)
          const sharedQuota = (e.shared_quota === null || e.shared_quota === undefined) ? null : Number(e.shared_quota);
          const sharedSold = evSoldMap[e.id] || 0;
          const sharedRemaining = sharedQuota === null ? null : Math.max(0, sharedQuota - sharedSold);
          return {
            id: e.id, name: e.name, date: e.date, location: e.location,
            club: e.club || null,
            description: e.description, active: e.active, layout: e.layout || null,
            imageUrl: e.image_url || null,
            ownerEmail: e.owner_email || null,
            // Zusätzliche Veranstalter (Mit-Verwalter, ohne Auszahlung)
            coOwners: Array.isArray(e.event_owners) ? e.event_owners.map(o => o.email).filter(Boolean) : [],
            sharedQuota: sharedQuota, sharedSold: sharedSold, sharedRemaining: sharedRemaining,
            feesOnOrganizer: !!e.fees_on_organizer,
            sponsorLogos: Array.isArray(e.sponsor_logos) ? e.sponsor_logos : [],
            categories: (e.categories || [])
              .sort((a, b) => (a.sort || 0) - (b.sort || 0))
              .map(c => ({
                id: c.id, name: c.name, price: Number(c.price), quota: c.quota,
                maxPerOrder: c.max_per_order, description: c.description, active: c.active,
                seating: !!c.seating,
                sold: soldMap[c.id] || 0,
                // Bei aktivem Gesamtkontingent gilt der gemeinsame Rest für jede Kategorie.
                remaining: sharedQuota === null
                  ? Math.max(0, c.quota - (soldMap[c.id] || 0))
                  : sharedRemaining
              }))
          };
        });
    },

    /* --- Sitzplätze --- */
    async seatMap(eventId) {
      const { data, error } = await sb.rpc('seat_map', { p_event: eventId });
      if (error) throw new Error(error.message);
      return (data || []).map(s => ({ id: s.id, row: s.row_no, table: s.table_no, seat: s.seat_no, status: s.status }));
    },
    async seatCount(eventId) {
      const { count } = await sb.from('seats').select('id', { count: 'exact', head: true }).eq('event_id', eventId);
      return count || 0;
    },
    async generateSeats(eventId, rows, tables, perTable) {
      rows = parseInt(rows, 10); tables = parseInt(tables, 10); perTable = parseInt(perTable, 10);
      if (!(rows > 0 && tables > 0 && perTable > 0)) throw new Error('Bitte Reihen, Tische und Sitze (je > 0) angeben.');
      if (rows * tables * perTable > 2000) throw new Error('Maximal 2000 Sitzplätze pro Event.');
      const seatRows = [];
      for (let r = 1; r <= rows; r++)
        for (let t = 1; t <= tables; t++)
          for (let s = 1; s <= perTable; s++)
            seatRows.push({ event_id: eventId, row_no: r, table_no: t, seat_no: s });
      // in Blöcken einfügen
      for (let i = 0; i < seatRows.length; i += 500) {
        const { error } = await sb.from('seats').insert(seatRows.slice(i, i + 500));
        if (error) throw new Error(error.message);
      }
      return seatRows.length;
    },
    // Admin: Sitzplan mit Belegung (wer sitzt wo)
    async adminSeatMap(eventId) {
      const { data, error } = await sb.rpc('admin_seat_map', { p_event: eventId });
      if (error) throw new Error(error.message.replace(/^.*?: /, ''));
      return (data || []).map(s => ({
        id: s.id, row: s.row_no, table: s.table_no, seat: s.seat_no, status: s.status,
        code: s.ticket_code, email: s.guest_email, checkedIn: s.checked_in
      }));
    },
    // Admin: Gast umsetzen (Ziel frei) oder zwei Gäste tauschen (Ziel belegt)
    async moveSeat(fromSeatId, toSeatId) {
      const { data, error } = await sb.rpc('admin_move_seat', { p_from: fromSeatId, p_to: toSeatId });
      if (error) throw new Error(error.message.replace(/^.*?: /, ''));
      return data; // { action: 'move'|'swap', moved, swapped_with? }
    },
    async clearSeats(eventId) {
      // nur möglich, wenn keine Plätze verkauft sind
      const map = await this.seatMap(eventId);
      if (map.some(s => s.status === 'sold')) throw new Error('Es sind bereits Sitzplätze verkauft – Plan kann nicht geleert werden.');
      const { error } = await sb.from('seats').delete().eq('event_id', eventId);
      if (error) throw new Error(error.message);
    },

    /* --- Saalplan-Layout (grafischer Editor) --- */
    async getLayout(eventId) {
      const { data, error } = await sb.from('events').select('layout').eq('id', eventId).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? data.layout : null;
    },
    async saveLayout(eventId, layout) {
      const { error } = await sb.from('events').update({ layout }).eq('id', eventId);
      if (error) throw new Error(error.message);
    },
    // Erzeugt die buchbaren Sitzplätze aus den Tischen des Layouts.
    // tables: [{ no, seats }]. Schützt bereits verkaufte Pläne.
    async generateSeatsFromLayout(eventId, tables) {
      const map = await this.seatMap(eventId);
      if (map.some(s => s.status === 'sold'))
        throw new Error('Es sind bereits Sitzplätze verkauft – die Plätze können nicht neu erzeugt werden. Bitte zuerst die Verkäufe klären.');
      const { error: delErr } = await sb.from('seats').delete().eq('event_id', eventId);
      if (delErr) throw new Error(delErr.message);
      const rows = [];
      (tables || []).forEach(t => {
        const n = Math.max(0, parseInt(t.seats, 10) || 0);
        for (let s = 1; s <= n; s++) rows.push({ event_id: eventId, row_no: 1, table_no: t.no, seat_no: s });
      });
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from('seats').insert(rows.slice(i, i + 500));
        if (error) throw new Error(error.message);
      }
      return rows.length;
    },

    /* --- Checkout (Stripe) --- */
    async startCheckout(items, returnPath) {
      // items: [{category_id, qty, seat_ids?}] – Edge Function prüft alles serverseitig.
      // returnPath (optional): Shop-Seite für die Rückkehr nach der Zahlung
      // (z. B. '/shop/' für den weißen Shop); ohne Angabe: /tickets.html.
      const body = { items, origin: location.origin };
      if (returnPath) body.return_path = returnPath;
      const { data, error } = await sb.functions.invoke('create-checkout', { body });
      if (error) {
        let msg = 'Zahlung konnte nicht gestartet werden.';
        try {
          const body = await error.context.json();
          if (body && body.error) msg = body.error;
        } catch (_) { /* Standardmeldung */ }
        throw new Error(msg);
      }
      return data; // { url, order_id }
    },

    // Gebühren-Aufschlüsselung (nur Anzeige – maßgeblich ist die Berechnung serverseitig)
    feeBreakdown(subtotal, tickets) {
      const r2 = n => Math.round(n * 100) / 100;
      const service = subtotal > 0 ? r2(0.035 * subtotal + 0.25 * tickets) : 0;
      const payment = subtotal > 0 ? r2(0.015 * subtotal + 0.25 * tickets) : 0;
      return { subtotal, service, payment, total: r2(subtotal + service + payment) };
    },

    // Gebühren-Aufschlüsselung je Warenkorb-Zeile: Zeilen von Events mit
    // feesOnOrganizer=true tragen keine Gebühr (Kunde zahlt dort exakt den Ticketpreis).
    feeBreakdownLines(lines) {
      const r2 = n => Math.round(n * 100) / 100;
      let subtotal = 0, feeSub = 0, feeTickets = 0;
      (lines || []).forEach(l => {
        subtotal += l.sum;
        if (!(l.ev && l.ev.feesOnOrganizer)) { feeSub += l.sum; feeTickets += l.qty; }
      });
      const service = feeSub > 0 ? r2(0.035 * feeSub + 0.25 * feeTickets) : 0;
      const payment = feeSub > 0 ? r2(0.015 * feeSub + 0.25 * feeTickets) : 0;
      return { subtotal: r2(subtotal), service, payment, total: r2(subtotal + service + payment) };
    },

    // Sponsor-Logos eines Events (für die Ticket-PDF). Öffentlich lesbar.
    async eventSponsorLogos(eventId) {
      if (!eventId) return [];
      const { data, error } = await sb.from('events').select('sponsor_logos').eq('id', eventId).maybeSingle();
      if (error) return [];
      return Array.isArray(data && data.sponsor_logos) ? data.sponsor_logos : [];
    },

    // Eigenes Ticket-Design eines Events (für die Ticket-PDF). Öffentlich lesbar.
    // Liefert { front, back } (Bild-Data-URLs) oder null (= Standardvorlage).
    async eventCustomTicket(eventId) {
      if (!eventId) return null;
      const { data, error } = await sb.from('events').select('custom_ticket').eq('id', eventId).maybeSingle();
      if (error || !data || !data.custom_ticket || !data.custom_ticket.front) return null;
      return data.custom_ticket;
    },

    /* --- Einlass-Scanner (passwortgeschützt, pro Event) --- */
    // Passwort setzen/ändern (leerer String = deaktivieren). Nur Event-Besitzer.
    async setCheckinPassword(eventId, password) {
      const { error } = await sb.rpc('set_checkin_password', { p_event: eventId, p_password: password || '' });
      if (error) throw new Error(error.message.replace(/^.*?: /, ''));
    },
    async checkinHasPassword(eventId) {
      const { data, error } = await sb.rpc('checkin_has_password', { p_event: eventId });
      if (error) return false;
      return !!data;
    },
    // Login auf der Einlass-Seite (anon): prüft das Passwort, liefert Eventdaten.
    async verifyCheckinPassword(eventId, password) {
      const { data, error } = await sb.rpc('verify_checkin_password', { p_event: eventId, p_password: password });
      if (error) throw new Error(error.message.replace(/^.*?: /, ''));
      return data; // { ok, event, date, location } | { ok:false, reason? }
    },
    // Check-in per Passwort (anon), streng auf das Event begrenzt.
    async checkInWithPassword(eventId, password, code) {
      const { data, error } = await sb.rpc('check_in_with_password', {
        p_event: eventId, p_password: password, p_code: this.extractCode(code)
      });
      if (error) throw new Error(error.message.replace(/^.*?: /, ''));
      return data; // { code, category, event, email, seat }
    },

    // Stripe Connect (Auszahlungskonto des Veranstalters)
    async connectStatus() {
      const { data, error } = await sb.functions.invoke('connect-onboard', { body: { action: 'status' } });
      if (error) { let m = 'Status nicht abrufbar.'; try { const b = await error.context.json(); if (b && b.error) m = b.error; } catch (_) {} throw new Error(m); }
      return data; // { hasAccount, chargesEnabled }
    },
    async connectLink() {
      const { data, error } = await sb.functions.invoke('connect-onboard', { body: { action: 'link' } });
      if (error) { let m = 'Verbindung fehlgeschlagen.'; try { const b = await error.context.json(); if (b && b.error) m = b.error; } catch (_) {} throw new Error(m); }
      return data; // { url, hasAccount, chargesEnabled }
    },

    /* --- Bestellungen --- */
    async myOrders() {
      const email = this.currentUser();
      if (!email) return [];
      const { data, error } = await sb.from('orders').select(ORDER_SELECT)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data || []).map(mapOrder);
    },

    async getOrder(id) {
      const { data, error } = await sb.from('orders').select(ORDER_SELECT).eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? mapOrder(data) : null;
    },

    // Wartet nach Rückkehr von Stripe, bis der Webhook die Bestellung bestätigt hat
    async waitForPayment(orderId, timeoutMs) {
      const until = Date.now() + (timeoutMs || 25000);
      while (Date.now() < until) {
        const o = await this.getOrder(orderId);
        if (o && o.status === 'bezahlt') return o;
        await new Promise(r => setTimeout(r, 1800));
      }
      return this.getOrder(orderId);
    },

    /* --- Admin --- */
    async isAdmin() {
      const email = this.currentUser();
      if (!email) return false;
      const { data } = await sb.from('admins').select('email').eq('email', email).maybeSingle();
      return !!data;
    },

    /* --- Rollen & Mandanten (Multi-Veranstalter) --- */
    async currentRole() {
      const email = this.currentUser();
      if (!email) return null;
      const { data } = await sb.from('admins').select('role').eq('email', email).maybeSingle();
      return data ? data.role : null;
    },
    async isSuperAdmin() { return (await this.currentRole()) === 'super_admin'; },

    // Events, die der aktuelle Nutzer verwalten darf (Head-Admin: alle; Veranstalter: eigene)
    async getManagedEvents(includeInactive) {
      const role = await this.currentRole();
      const evs = await this.getEvents(includeInactive);
      if (role === 'super_admin') return evs;
      const me = this.currentUser();
      // Veranstalter sehen eigene Bälle UND Bälle, bei denen sie als
      // Mit-Veranstalter eingetragen sind.
      return evs.filter(e => e.ownerEmail === me || (e.coOwners || []).includes(me));
    },

    // Veranstalter-Verwaltung (nur Head-Admin)
    async getOrganizers() {
      const { data, error } = await sb.from('admins').select('email,role').order('email');
      if (error) throw new Error(error.message);
      return (data || []);
    },
    async addOrganizer(email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const { error } = await sb.from('admins').insert({ email, role: 'organizer' });
      if (error) throw new Error(error.message);
    },
    async removeOrganizer(email) {
      const { error } = await sb.from('admins').delete().eq('email', normEmail(email));
      if (error) throw new Error(error.message);
    },
    async setEventOwner(eventId, ownerEmail) {
      const { error } = await sb.from('events').update({ owner_email: ownerEmail ? normEmail(ownerEmail) : null }).eq('id', eventId);
      if (error) throw new Error(error.message);
    },

    /* --- Mit-Veranstalter je Ball (zusätzliche Verwalter, keine Auszahlung) --- */
    async getEventCoOwners(eventId) {
      const { data, error } = await sb.from('event_owners').select('email').eq('event_id', eventId).order('email');
      if (error) throw new Error(error.message);
      return (data || []).map(o => o.email);
    },
    async addEventCoOwner(eventId, email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const { error } = await sb.from('event_owners').insert({ event_id: eventId, email });
      if (error) {
        // Doppelte Zuweisung freundlich melden
        if (error.code === '23505') throw new Error('Diese E-Mail ist bereits als Veranstalter zugewiesen.');
        throw new Error(error.message);
      }
    },
    async removeEventCoOwner(eventId, email) {
      const { error } = await sb.from('event_owners').delete().eq('event_id', eventId).eq('email', normEmail(email));
      if (error) throw new Error(error.message);
    },
    /* --- Club-Veranstalter (dauerhaft je Club; nur Head-Admin darf schreiben) --- */
    async getClubOwners(club) {
      const { data, error } = await sb.from('club_owners').select('email').eq('club', club).order('email');
      if (error) throw new Error(error.message);
      return (data || []).map(o => o.email);
    },
    async addClubOwner(club, email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const { error } = await sb.from('club_owners').insert({ club, email });
      if (error) {
        if (error.code === '23505') throw new Error('Diese E-Mail ist bereits diesem Club zugewiesen.');
        throw new Error(error.message);
      }
    },
    async removeClubOwner(club, email) {
      const { error } = await sb.from('club_owners').delete().eq('club', club).eq('email', normEmail(email));
      if (error) throw new Error(error.message);
    },

    async allOrders() {
      const { data, error } = await sb.from('orders').select(ORDER_SELECT)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data || []).map(mapOrder);
    },

    async setOrderStatus(orderId, status) {
      const { error } = await sb.from('orders').update({ status }).eq('id', orderId);
      if (error) throw new Error(error.message);
    },

    // Admin: Tickets ausstellen und per E-Mail versenden
    async issueTickets({ categoryId, qty, email, mode, note }) {
      const { data, error } = await sb.functions.invoke('issue-tickets', {
        body: { category_id: categoryId, qty, email, mode, note }
      });
      if (error) {
        let msg = 'Tickets konnten nicht ausgestellt werden.';
        try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (_) {}
        throw new Error(msg);
      }
      return data; // { order_id, codes, total, emailed }
    },

    // Ticketcode aus beliebigem Scan-/Eingabetext ziehen (auch aus QR-URLs)
    extractCode(text) {
      const m = String(text || '').toUpperCase().match(/CM-[A-Z0-9]{4}-[A-Z0-9]{4}/);
      return m ? m[0] : String(text || '').trim().toUpperCase();
    },

    async checkIn(code) {
      const { data, error } = await sb.rpc('check_in_ticket', { p_code: this.extractCode(code) });
      if (error) throw new Error(error.message.replace(/^.*?: /, ''));
      return data; // { code, category, event, email }
    },

    // Öffentliche Statusabfrage (für die Ticket-Seite hinter dem QR-Code)
    async ticketStatus(code) {
      const { data, error } = await sb.rpc('ticket_status', { p_code: this.extractCode(code) });
      if (error) throw new Error(error.message);
      return data;
    },

    /* --- Event-/Kategorie-Verwaltung (Admin, modular) --- */
    async uploadEventImage(file, eventId) {
      const ext = ((file.name.split('.').pop()) || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = 'events/' + (eventId || ('neu-' + Date.now())) + '-' + Date.now() + '.' + ext;
      const { error } = await sb.storage.from('event-images').upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (error) throw new Error(error.message);
      const { data } = sb.storage.from('event-images').getPublicUrl(path);
      return data.publicUrl;
    },
    async saveEvent(ev) {
      const row = {
        name: ev.name, date: ev.date || null, location: ev.location || null,
        description: ev.description || null, active: !!ev.active,
        // In diesem Projekt angelegte Events gehören immer zum Focus-Storefront.
        storefront: STOREFRONT
      };
      // Club-Zuordnung (LEVEL/YPSILON) nur setzen, wenn übergeben.
      if (ev.club !== undefined) row.club = ev.club || null;
      // Gesamtkontingent nur setzen, wenn explizit übergeben (sonst bestehenden Wert nicht überschreiben).
      // null = deaktiviert, Zahl = gemeinsamer Topf.
      if (ev.sharedQuota !== undefined) {
        row.shared_quota = (ev.sharedQuota === null || ev.sharedQuota === '') ? null : Math.max(0, parseInt(ev.sharedQuota, 10) || 0);
      }
      // Gebühren-Modus nur setzen, wenn explizit übergeben.
      if (ev.feesOnOrganizer !== undefined) row.fees_on_organizer = !!ev.feesOnOrganizer;
      // Sponsor-Logos nur setzen, wenn explizit übergeben.
      if (ev.sponsorLogos !== undefined) row.sponsor_logos = Array.isArray(ev.sponsorLogos) ? ev.sponsorLogos : [];
      // Besitzer nur setzen, wenn explizit übergeben (sonst bestehenden nicht überschreiben)
      if (ev.imageUrl !== undefined) row.image_url = ev.imageUrl || null;
      if (ev.ownerEmail !== undefined) row.owner_email = ev.ownerEmail ? normEmail(ev.ownerEmail) : null;
      let eventId = ev.id;
      if (eventId) {
        const { error } = await sb.from('events').update(row).eq('id', eventId);
        if (error) throw new Error(error.message);
      } else {
        const { data, error } = await sb.from('events').insert(row).select('id').single();
        if (error) throw new Error(error.message);
        eventId = data.id;
      }
      // Kategorien abgleichen
      const { data: existing } = await sb.from('categories').select('id').eq('event_id', eventId);
      const keep = new Set();
      for (let i = 0; i < ev.categories.length; i++) {
        const c = ev.categories[i];
        const crow = {
          event_id: eventId, name: c.name, price: c.price, quota: c.quota,
          max_per_order: c.maxPerOrder || 10, description: c.description || null,
          active: !!c.active, sort: i, seating: !!c.seating
        };
        if (c.id && (existing || []).some(x => x.id === c.id)) {
          keep.add(c.id);
          const { error } = await sb.from('categories').update(crow).eq('id', c.id);
          if (error) throw new Error(error.message);
        } else {
          const { data, error } = await sb.from('categories').insert(crow).select('id').single();
          if (error) throw new Error(error.message);
          keep.add(data.id);
        }
      }
      for (const x of existing || []) {
        if (!keep.has(x.id)) await sb.from('categories').delete().eq('id', x.id);
      }
      return eventId;
    },

    async setEventActive(id, active) {
      const { error } = await sb.from('events').update({ active }).eq('id', id);
      if (error) throw new Error(error.message);
    },

    async deleteEvent(id) {
      const { error } = await sb.from('events').delete().eq('id', id);
      if (error) throw new Error(error.message);
    },

    async getAdmins() {
      const { data, error } = await sb.from('admins').select('email').order('email');
      if (error) throw new Error(error.message);
      return (data || []).map(a => a.email);
    },
    async addAdmin(email) {
      email = normEmail(email);
      if (!validEmail(email)) throw new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
      const { error } = await sb.from('admins').insert({ email });
      if (error) throw new Error(error.message);
    },
    async removeAdmin(email) {
      const { error } = await sb.from('admins').delete().eq('email', normEmail(email));
      if (error) throw new Error(error.message);
    },

    /* --- Statistik (aus geladenen Bestellungen berechnet) --- */
    stats(orders) {
      const valid = orders.filter(o => o.status !== 'storniert');
      const tickets = valid.flatMap(o => o.tickets);
      const paid = valid.filter(o => o.status === 'bezahlt');
      return {
        revenue: paid.reduce((s, o) => s + o.total, 0),
        orderCount: valid.length,
        ticketCount: tickets.length,
        checkinCount: tickets.filter(t => t.checkedIn).length,
        openCount: orders.filter(o => o.status === 'offen').length
      };
    },

    salesByDay(orders, days) {
      const out = [];
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        out.push({ date: d, label: d.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' }), qty: 0, revenue: 0 });
      }
      orders.forEach(o => {
        if (o.status !== 'bezahlt') return;
        const od = new Date(o.createdAt); od.setHours(0, 0, 0, 0);
        const slot = out.find(x => x.date.getTime() === od.getTime());
        if (slot) { slot.qty += o.tickets.length; slot.revenue += o.total; }
      });
      return out;
    },

    revenueByCategory(orders) {
      const map = {};
      orders.forEach(o => {
        if (o.status !== 'bezahlt') return;
        o.items.forEach(it => {
          const key = it.categoryName + ' · ' + it.eventName;
          if (!map[key]) map[key] = { label: it.categoryName, event: it.eventName, revenue: 0, qty: 0 };
          map[key].revenue += it.price * it.qty;
          map[key].qty += it.qty;
        });
      });
      return Object.values(map).sort((a, b) => b.revenue - a.revenue);
    },

    exportOrdersCSV(orders) {
      const rows = [['Bestellung', 'Datum', 'E-Mail', 'Status', 'Zahlart', 'Ticketcode', 'Event', 'Kategorie', 'Preis', 'Check-in']];
      orders.forEach(o => {
        if (o.tickets.length) {
          o.tickets.forEach(t => rows.push([o.id, o.createdAt, o.email, o.status, o.paidVia || '', t.code,
            t.eventName, t.categoryName, String(t.price).replace('.', ','), t.checkedIn ? t.checkedInAt : '']));
        } else {
          o.items.forEach(i => rows.push([o.id, o.createdAt, o.email, o.status, o.paidVia || '', '',
            i.eventName, i.qty + '× ' + i.categoryName, String(i.price * i.qty).replace('.', ','), '']));
        }
      });
      return rows.map(r => r.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
    }
  };

  global.CMStore = Store;
})(window);
