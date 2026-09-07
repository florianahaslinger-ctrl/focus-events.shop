/* FOCUS Ticketshop – Weiße Version (shop/index.html)
   Eigenständige Kopie der Shop-Logik, damit der klassische Shop
   (tickets.html + assets/shop.js) unverändert weiterläuft.
   Backend: Supabase + Stripe Checkout (echte Online-Zahlung). */
(function () {
  'use strict';
  const S = window.CMStore;
  const $ = id => document.getElementById(id);

  let cart = {};          // { categoryId: qty }
  let selectedSeats = {}; // { categoryId: [seatId, …] }
  let eventsCache = [];
  let pendingEmail = '';
  let afterLogin = null;

  function msg(el, text, type) {
    el.textContent = text || '';
    el.className = 'msg' + (text ? ' show ' + (type || 'info') : '');
  }
  window.closeModal = id => $(id).classList.remove('open');
  function openModal(id) { $(id).classList.add('open'); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('de-AT', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }

  /* ---------- Navigation / Auth-Status ---------- */
  async function renderNav() {
    const user = S.currentUser();
    const a = $('navAuth');
    const dash = $('navDash');
    if (user) {
      a.textContent = user + ' · Abmelden';
      a.onclick = async e => { e.preventDefault(); await S.logout(); renderNav(); renderMyTickets(); };
    } else {
      a.textContent = 'Anmelden';
      a.onclick = e => { e.preventDefault(); openLogin(); };
    }
    // Dashboard-Link nur für Admins zeigen – Kund:innen sehen ihn nie
    if (dash) {
      dash.style.display = 'none';
      if (user) {
        try { if (await S.isAdmin()) dash.style.display = ''; } catch (_) {}
      }
    }
  }

  /* ---------- Eventliste ---------- */
  async function renderEvents() {
    const box = $('eventList');
    try {
      eventsCache = await S.getEvents();
      const evParam = new URLSearchParams(location.search).get('event');
      if (evParam) eventsCache = eventsCache.filter(e => e.id === evParam);
    } catch (e) {
      box.innerHTML = '<div class="card"><h2>Shop derzeit nicht erreichbar</h2><p class="sub">' + esc(e.message) + '</p></div>';
      return;
    }
    if (!eventsCache.length) {
      box.innerHTML = '<div class="card"><h2>Derzeit keine Tickets im Verkauf</h2>' +
        '<p class="sub">Schau bald wieder vorbei – neue Events werden hier angekündigt.</p></div>';
      return;
    }
    box.innerHTML = eventsCache.map(ev => {
      const rows = ev.categories.filter(c => c.active).map(cat => {
        const rest = cat.remaining;
        const qty = cart[cat.id] || 0;
        const leftCls = rest === 0 ? 'out' : (rest <= 15 ? 'low' : '');
        const leftTxt = rest === 0 ? 'Ausverkauft' : (rest <= 15 ? 'Nur noch ' + rest + ' verfügbar' : rest + ' verfügbar');
        const maxQty = Math.min(rest, cat.maxPerOrder || 10);
        return '<div class="cat-row">' +
          '<div class="cat-info"><div class="name">' + esc(cat.name) + '</div>' +
          (cat.description ? '<div class="desc">' + esc(cat.description) + '</div>' : '') + '</div>' +
          '<div class="cat-price">' + S.fmtEUR.format(cat.price) + '</div>' +
          '<div class="cat-left ' + leftCls + '">' + leftTxt + '</div>' +
          (rest > 0
            ? '<div class="qty">' +
              '<button type="button" data-key="' + cat.id + '" data-d="-1" aria-label="weniger">−</button>' +
              '<input type="text" readonly value="' + qty + '" data-qty="' + cat.id + '">' +
              '<button type="button" data-key="' + cat.id + '" data-d="1" data-max="' + maxQty + '" aria-label="mehr">+</button></div>'
            : '') +
          '</div>';
      }).join('');
      return '<div class="card">' +
        '<div class="event-head"><h2>' + esc(ev.name) + '</h2>' +
        '<span class="event-meta"><b>' + fmtDate(ev.date) + '</b>' +
        (ev.location ? ' · ' + esc(ev.location) : '') + '</span></div>' +
        (ev.description ? '<p class="sub">' + esc(ev.description) + '</p>' : '') +
        rows + '</div>';
    }).join('');

    box.querySelectorAll('.qty button').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        const d = parseInt(btn.dataset.d, 10);
        const max = btn.dataset.max ? parseInt(btn.dataset.max, 10) : 99;
        cart[key] = Math.max(0, Math.min(max, (cart[key] || 0) + d));
        if (!cart[key]) delete cart[key];
        delete selectedSeats[key]; // Sitzplatzwahl bei Mengenänderung zurücksetzen
        box.querySelector('[data-qty="' + key + '"]').value = cart[key] || 0;
        renderCartBar();
      });
    });
  }

  function cartDetails() {
    let total = 0, count = 0;
    const lines = [];
    eventsCache.forEach(ev => ev.categories.forEach(cat => {
      const qty = cart[cat.id] || 0;
      if (!qty) return;
      total += cat.price * qty; count += qty;
      lines.push({ ev, cat, qty, sum: cat.price * qty });
    }));
    return { total, count, lines };
  }

  function renderCartBar() {
    const { total, count, lines } = cartDetails();
    const bar = $('cartBar');
    if (!count) { bar.classList.remove('visible'); return; }
    bar.classList.add('visible');
    $('cartDesc').textContent = lines.map(l => l.qty + '× ' + l.cat.name).join(' · ');
    $('cartSum').textContent = S.fmtEUR.format(total);
  }

  /* ---------- Login (E-Mail + Verifizierung) ---------- */
  window.openLogin = function (cb) {
    afterLogin = typeof cb === 'function' ? cb : null;
    $('loginStep1').style.display = '';
    $('loginStep2').style.display = 'none';
    msg($('loginMsg1'), ''); msg($('loginMsg2'), '');
    openModal('loginModal');
    $('loginEmail').focus();
  };

  window.backToStep1 = function () {
    $('loginStep1').style.display = '';
    $('loginStep2').style.display = 'none';
  };

  async function sendCode(isResend) {
    const email = isResend ? pendingEmail : $('loginEmail').value;
    const m1 = isResend ? $('loginMsg2') : $('loginMsg1');
    const btn = isResend ? $('btnResend') : $('btnSendCode');
    try {
      btn.disabled = true;
      msg(m1, 'E-Mail wird gesendet …', 'info');
      await S.requestCode(email);
      pendingEmail = S.normEmail(email);
      $('loginStep1').style.display = 'none';
      $('loginStep2').style.display = '';
      $('sentInfo').textContent = 'Wir haben eine E-Mail an ' + pendingEmail +
        ' gesendet. Klicke den Anmelde-Link darin – oder gib den Code aus der E-Mail hier ein. Bitte auch den Spam-Ordner prüfen.';
      msg($('loginMsg2'), ''); msg($('loginMsg1'), '');
      $('loginCode').value = '';
      $('loginCode').focus();
    } catch (e) {
      msg(m1, e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function verify() {
    try {
      $('btnVerify').disabled = true;
      await S.verifyCode(pendingEmail, $('loginCode').value);
      closeModal('loginModal');
      renderNav();
      renderMyTickets();
      if (afterLogin) { const cb = afterLogin; afterLogin = null; cb(); }
    } catch (e) {
      msg($('loginMsg2'), e.message, 'error');
    } finally {
      $('btnVerify').disabled = false;
    }
  }

  /* ---------- Sitzplatz-Auswahl ---------- */
  function seatLabel(s) {
    return 'Reihe ' + s.row + ' · Tisch ' + s.table + ' · Platz ' + s.seat;
  }

  async function openSeatPicker(line, doneCb) {
    const need = line.qty;
    let seats;
    try { seats = await S.seatMap(line.ev.id); }
    catch (e) { msg($('checkoutMsg'), 'Sitzplan konnte nicht geladen werden: ' + e.message, 'error'); return; }
    if (!seats.length) {
      // Sichtbare Rückmeldung statt „toter" Button: Modal mit Hinweis öffnen.
      $('seatTitle').textContent = 'Sitzplan nicht verfügbar';
      $('seatSub').textContent = line.cat.name + ' – ' + line.ev.name;
      $('seatMapArea').innerHTML = '<p class="sub" style="padding:24px 8px">Für diese Ticketkategorie ist noch kein Sitzplan hinterlegt. Bitte wende dich an die Veranstalter.</p>';
      $('seatCount').textContent = '';
      $('btnSeatConfirm').disabled = true;
      openModal('seatModal');
      return;
    }
    seatById[line.ev.id] = {};
    seats.forEach(s => { seatById[line.ev.id][s.id] = s; });
    const chosen = new Set();
    $('seatTitle').textContent = need + (need > 1 ? ' Sitzplätze' : ' Sitzplatz') + ' wählen';
    $('seatSub').textContent = line.cat.name + ' – ' + line.ev.name;

    // nach Reihe → Tisch gruppieren
    const rows = {};
    seats.forEach(s => {
      rows[s.row] = rows[s.row] || {};
      rows[s.row][s.table] = rows[s.row][s.table] || [];
      rows[s.row][s.table].push(s);
    });

    function render() {
      $('seatCount').textContent = chosen.size + ' / ' + need + ' gewählt';
      $('btnSeatConfirm').disabled = chosen.size !== need;
      $('seatMapArea').innerHTML = Object.keys(rows).map(r =>
        '<div class="seat-row"><div class="seat-row-label">Reihe ' + esc(r) + '</div>' +
        '<div class="seat-tables">' + Object.keys(rows[r]).map(t =>
          '<div class="seat-table"><div class="seat-table-label">Tisch ' + esc(t) + '</div>' +
          '<div class="seat-dots">' + rows[r][t].map(s => {
            const sel = chosen.has(s.id);
            const cls = s.status !== 'free' ? 'taken' : (sel ? 'sel' : 'free');
            return '<button type="button" class="seat ' + cls + '" data-id="' + s.id +
              '" ' + (s.status !== 'free' ? 'disabled' : '') + ' title="' + esc(seatLabel(s)) + '">' + s.seat + '</button>';
          }).join('') + '</div></div>').join('') +
        '</div></div>').join('');
      $('seatMapArea').querySelectorAll('.seat.free, .seat.sel').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          if (chosen.has(id)) chosen.delete(id);
          else { if (chosen.size >= need) return; chosen.add(id); }
          render();
        });
      });
    }
    render();
    $('btnSeatConfirm').onclick = () => {
      if (chosen.size !== need) return;
      doneCb(Array.from(chosen));
      closeModal('seatModal');
    };
    openModal('seatModal');
  }

  /* ---------- Checkout (Stripe) ---------- */
  function openCheckout() {
    const user = S.currentUser();
    if (!user) { openLogin(openCheckout); return; }
    const { lines } = cartDetails();
    if (!lines.length) return;
    // Sitzkarten ohne (passende) Platzwahl → zuerst Sitzplan öffnen
    const needSeat = lines.find(l => l.cat.seating &&
      (!(selectedSeats[l.cat.id]) || selectedSeats[l.cat.id].length !== l.qty));
    if (needSeat) {
      openSeatPicker(needSeat, (ids) => { selectedSeats[needSeat.cat.id] = ids; openCheckout(); });
      return;
    }
    renderCheckoutSummary();
  }

  function renderCheckoutSummary() {
    const user = S.currentUser();
    const { total, count, lines } = cartDetails();
    $('checkoutEmail').textContent = 'Bestellung für: ' + user;
    $('checkoutItems').innerHTML = lines.map(l => {
      let seatInfo = '';
      if (l.cat.seating && selectedSeats[l.cat.id]) {
        const map = seatById[l.ev.id] || {};
        seatInfo = '<div class="desc" style="color:var(--gold-light)">Plätze: ' +
          selectedSeats[l.cat.id].map(id => map[id] ? ('R' + map[id].row + '·T' + map[id].table + '·P' + map[id].seat) : '?').join(', ') +
          ' <button type="button" class="linklike" data-changeseat="' + l.cat.id + '">ändern</button></div>';
      }
      return '<div class="cat-row"><div class="cat-info"><div class="name">' + l.qty + '× ' + esc(l.cat.name) + '</div>' +
        '<div class="desc">' + esc(l.ev.name) + ' · ' + fmtDate(l.ev.date) + '</div>' + seatInfo + '</div>' +
        '<div class="cat-price">' + S.fmtEUR.format(l.sum) + '</div></div>';
    }).join('');
    const fb = S.feeBreakdownLines(lines);
    if (fb.total > fb.subtotal) {
      const feeRow = (name, hint, val) => '<div class="cat-row" style="opacity:.85"><div class="cat-info">' +
        '<div class="name" style="font-weight:400">' + name + '</div>' + (hint ? '<div class="desc">' + hint + '</div>' : '') +
        '</div><div class="cat-price">' + S.fmtEUR.format(val) + '</div></div>';
      $('checkoutItems').innerHTML += feeRow('Zwischensumme', '', fb.subtotal) +
        feeRow('Servicegebühr', '3,5 % + 0,25 €/Ticket', fb.service) +
        feeRow('Zahlungsgebühr', '1,5 % + 0,25 €/Ticket', fb.payment);
    }
    $('checkoutTotal').textContent = 'Gesamt: ' + S.fmtEUR.format(fb.total);
    $('checkoutNote').textContent = 'Du wirst zur sicheren Stripe-Bezahlseite weitergeleitet ' +
      '(Kreditkarte, Apple Pay u. a.). Deine Tickets werden sofort nach erfolgreicher Zahlung freigeschaltet.';
    msg($('checkoutMsg'), '');
    $('checkoutItems').querySelectorAll('[data-changeseat]').forEach(b => b.addEventListener('click', () => {
      const catId = b.dataset.changeseat;
      delete selectedSeats[catId];
      closeModal('checkoutModal');
      openCheckout();
    }));
    openModal('checkoutModal');
  }

  // Cache: seatId -> seat (für Anzeige der gewählten Plätze)
  const seatById = {};
  async function cacheSeats(eventId) {
    if (seatById[eventId]) return;
    try {
      const seats = await S.seatMap(eventId);
      seatById[eventId] = {};
      seats.forEach(s => { seatById[eventId][s.id] = s; });
    } catch (_) {}
  }

  async function placeOrder() {
    const { lines } = cartDetails();
    const items = lines.map(l => {
      const it = { category_id: l.cat.id, qty: l.qty };
      if (l.cat.seating && selectedSeats[l.cat.id]) it.seat_ids = selectedSeats[l.cat.id];
      return it;
    });
    try {
      $('btnPlaceOrder').disabled = true;
      msg($('checkoutMsg'), 'Bezahlvorgang wird gestartet …', 'info');
      const res = await S.startCheckout(items, '/shop/');
      cart = {}; selectedSeats = {};
      window.location.href = res.url;
    } catch (e) {
      msg($('checkoutMsg'), e.message, 'error');
      $('btnPlaceOrder').disabled = false;
    }
  }

  /* ---------- Rückkehr von Stripe ---------- */
  async function handlePaymentReturn() {
    const params = new URLSearchParams(location.search);
    if (params.get('cancelled') === '1') {
      history.replaceState(null, '', location.pathname + location.hash);
      msg($('shopMsg'), 'Die Zahlung wurde abgebrochen – es wurden keine Tickets gekauft.', 'info');
      return;
    }
    const orderId = params.get('order');
    if (params.get('paid') !== '1' || !orderId) return;
    history.replaceState(null, '', location.pathname + location.hash);
    $('successSub').textContent = 'Zahlung wird bestätigt – einen Moment bitte …';
    $('successTickets').innerHTML = '';
    openModal('successModal');
    try {
      const order = await S.waitForPayment(orderId);
      if (!order) {
        $('successSub').textContent = 'Bestellung nicht gefunden. Bitte melde dich mit der E-Mail-Adresse an, mit der du bestellt hast.';
        return;
      }
      if (order.status !== 'bezahlt') {
        $('successSub').textContent = 'Deine Zahlung wird noch verarbeitet. Die Tickets erscheinen in wenigen Minuten unter „Meine Tickets“.';
        return;
      }
      $('successSub').textContent = 'Zahlung erfolgreich! Bestellnummer ' + order.id + ' · ' +
        order.tickets.length + ' Ticket(s) · ' + S.fmtEUR.format(order.total) +
        ' – deine Tickets sind jetzt gültig. Eine Zahlungsbestätigung kommt von Stripe per E-Mail.';
      $('successTickets').innerHTML =
        '<p style="margin:10px 0"><button class="btn btn-gold btn-sm" id="btnSuccessPdf">Tickets als PDF herunterladen</button></p>' +
        order.tickets.map(t => ticketHTML(t, order)).join('');
      drawQRCodes($('successTickets'));
      const pdfBtn = $('btnSuccessPdf');
      if (pdfBtn) pdfBtn.addEventListener('click', () => window.CMTicketPDF.download(order));
      renderEvents(); renderMyTickets();
    } catch (e) {
      $('successSub').textContent = 'Fehler beim Prüfen der Zahlung: ' + e.message;
    }
  }

  /* ---------- Meine Tickets ---------- */
  function ticketHTML(t, order) {
    const paid = order.status === 'bezahlt';
    return '<div class="ticket">' +
      (paid
        ? '<div class="qr" data-code="' + esc(t.code) + '"></div>'
        : '<div class="qr qr-pending"><div>QR-Code nach<br>Zahlungseingang</div></div>') +
      '<div class="tinfo">' +
      '<div class="tcode">' + esc(t.code) + '</div>' +
      '<div>' + esc(t.categoryName) + ' – ' + esc(t.eventName) + '</div>' +
      (t.seat ? '<div class="tseat">🎟 Reihe ' + t.seat.row + ' · Tisch ' + t.seat.table + ' · Platz ' + t.seat.seat + '</div>' : '') +
      '<div class="tmeta">' + fmtDate(t.eventDate) + (t.eventLocation ? ' · ' + esc(t.eventLocation) : '') +
      ' · ' + S.fmtEUR.format(t.price) + '</div>' +
      '<div style="margin-top:6px">' +
      '<span class="badge ' + esc(order.status) + '">' + esc(order.status) + '</span> ' +
      (t.checkedIn ? '<span class="badge checked">eingecheckt</span>' : '') +
      '</div></div></div>';
  }

  function drawQRCodes(root) {
    root.querySelectorAll('.qr[data-code]').forEach(el => {
      if (el.dataset.done) return;
      el.dataset.done = '1';
      try {
        const cv = window.CMTicketPDF.qrCanvas(window.CMTicketPDF.ticketUrl(el.dataset.code), 96);
        cv.style.width = cv.style.height = '100%';
        el.appendChild(cv);
      } catch (e) {
        el.innerHTML = '<div style="color:#000;font-size:11px;word-break:break-all;padding:4px">' + esc(el.dataset.code) + '</div>';
      }
    });
  }

  window.renderMyTickets = async function () {
    const box = $('myTicketsArea');
    const user = S.currentUser();
    if (!user) {
      box.innerHTML = '<p class="sub">Bitte melde dich mit deiner E-Mail-Adresse an, um deine Tickets zu sehen.</p>' +
        '<p style="margin-top:14px"><button class="btn btn-ghost" onclick="openLogin()">Jetzt anmelden</button></p>';
      return;
    }
    let orders;
    try { orders = await S.myOrders(); }
    catch (e) { box.innerHTML = '<p class="sub">Fehler beim Laden: ' + esc(e.message) + '</p>'; return; }
    if (!orders.length) {
      box.innerHTML = '<p class="sub">Angemeldet als <b style="color:var(--gold)">' + esc(user) +
        '</b> – noch keine Bestellungen vorhanden.</p>';
      return;
    }
    box.innerHTML = orders.map(o =>
      '<div style="margin-bottom:26px"><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
      '<b>Bestellung ' + esc(o.id) + '</b>' +
      '<span class="badge ' + esc(o.status) + '">' +
      (o.status === 'offen' ? 'Zahlung nicht abgeschlossen' : esc(o.status)) + '</span>' +
      '<span class="sub">' + new Date(o.createdAt).toLocaleString('de-AT') + ' · ' + S.fmtEUR.format(o.total) + '</span>' +
      (o.status === 'bezahlt'
        ? '<button class="btn btn-ghost btn-sm" data-pdf="' + esc(o.id) + '">Tickets als PDF</button>'
        : '') +
      '</div>' +
      (o.status === 'offen'
        ? '<p class="hint" style="margin-top:6px">Diese Bestellung wurde nicht bezahlt – einfach die Tickets erneut in den Warenkorb legen und neu bestellen.</p>'
        : o.tickets.map(t => ticketHTML(t, o)).join('')) +
      '</div>').join('');
    drawQRCodes(box);
    box.querySelectorAll('[data-pdf]').forEach(b => b.addEventListener('click', () => {
      const order = orders.find(o => o.id === b.dataset.pdf);
      if (order) window.CMTicketPDF.download(order);
    }));
  };

  /* ---------- Init ---------- */
  async function init() {
    $('btnSendCode').addEventListener('click', () => sendCode(false));
    $('btnResend').addEventListener('click', () => sendCode(true));
    $('btnVerify').addEventListener('click', verify);
    $('loginCode').addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });
    $('loginEmail').addEventListener('keydown', e => { if (e.key === 'Enter') sendCode(false); });
    $('btnCheckout').addEventListener('click', openCheckout);
    $('btnPlaceOrder').addEventListener('click', placeOrder);
    $('navMyTickets').addEventListener('click', () => setTimeout(renderMyTickets, 0));

    await S.init();          // stellt auch Sessions aus Magic-Link-URLs her
    renderNav();
    await renderEvents();
    renderCartBar();
    renderMyTickets();
    handlePaymentReturn();
  }
  init();
})();
