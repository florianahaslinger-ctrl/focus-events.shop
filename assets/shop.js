/* Focus Events Ticketshop – Shop-Logik (tickets.html)
   Backend: Supabase + Stripe Checkout (echte Online-Zahlung). */
(function () {
  'use strict';
  const S = window.CMStore;
  const $ = id => document.getElementById(id);

  let cart = {};          // { categoryId: qty }
  let selectedSeats = {}; // { categoryId: [seatId, …] }
  let eventsCache = [];
  let activeClub = 'LEVEL'; // aktiver Reiter: 'LEVEL' | 'YPSILON'
  let pendingEmail = '';
  let afterLogin = null;

  const CLUBS = ['LEVEL', 'YPSILON'];

  /* ---- Subdomain-Routing (Cloudflare Pages) ---- */
  // Nach dem Cloudflare-Setup + DNS auf true setzen, dann klickt ein Club auf seine Subdomain.
  const SUBDOMAINS_LIVE = true;
  const CLUB_HOSTS = { LEVEL: 'level.focus-events.shop', YPSILON: 'ypsilon.focus-events.shop' };
  function clubFromHost() {
    const h = location.hostname.toLowerCase();
    if (h === CLUB_HOSTS.LEVEL || h.startsWith('level.')) return 'LEVEL';
    if (h === CLUB_HOSTS.YPSILON || h.startsWith('ypsilon.')) return 'YPSILON';
    return null;
  }
  function syncClubTabs() {
    document.querySelectorAll('#clubTabs .fx-tab').forEach(x => {
      const on = x.dataset.club === activeClub;
      x.classList.toggle('active', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.documentElement.setAttribute('data-club', activeClub);
  }
  const clubOf = ev => String(ev.club || '').trim().toUpperCase();

  // Dynamic Pricing: kurzer Hinweis auf die nächste Preis-Phase
  function fmtPhaseDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  function nextPhaseHint(cat) {
    const n = cat && cat.nextPhase;
    if (!n) return '';
    const parts = [];
    if (n.endsAt) parts.push('ab ' + fmtPhaseDate(n.endsAt));
    if (n.endsQty != null) parts.push('ab ' + n.endsQty + ' verkauft');
    const when = parts.length ? parts.join(' bzw. ') : 'bald';
    return 'Danach ' + when + ': ' + S.fmtEUR.format(n.price);
  }

  // Eine Ticketkategorie-Zeile (identisch in Karte und Detail-Ansicht)
  function catRowHTML(cat) {
    const rest = cat.remaining;
    const qty = cart[cat.id] || 0;
    const leftCls = rest === 0 ? 'out' : (rest <= 15 ? 'low' : '');
    const leftTxt = rest === 0 ? 'Ausverkauft' : (rest <= 15 ? 'Nur noch ' + rest + ' verfügbar' : rest + ' verfügbar');
    const maxQty = Math.min(rest, cat.maxPerOrder || 10);
    return '<div class="cat-row">' +
      '<div class="cat-info"><div class="name">' + esc(cat.name) +
      (cat.currentPhaseName ? ' <span class="phase-tag">' + esc(cat.currentPhaseName) + '</span>' : '') + '</div>' +
      (cat.description ? '<div class="desc">' + esc(cat.description) + '</div>' : '') + '</div>' +
      '<div class="cat-price">' + S.fmtEUR.format(cat.price) + '</div>' +
      (rest > 0
        ? '<div class="qty">' +
          '<button type="button" data-key="' + cat.id + '" data-d="-1" aria-label="weniger">−</button>' +
          '<input type="text" readonly value="' + qty + '" data-qty="' + cat.id + '">' +
          '<button type="button" data-key="' + cat.id + '" data-d="1" data-max="' + maxQty + '" aria-label="mehr">+</button></div>'
        : '<div></div>') +
      '<div class="cat-left ' + leftCls + '">' + leftTxt + '</div>' +
      (nextPhaseHint(cat) ? '<div class="cat-next">' + nextPhaseHint(cat) + '</div>' : '') +
      '</div>';
  }

  // Mengenänderung – aktualisiert Warenkorb und ALLE Anzeigen (Karte + Detail-Modal)
  function changeQty(key, d, max) {
    cart[key] = Math.max(0, Math.min(max, (cart[key] || 0) + d));
    if (!cart[key]) delete cart[key];
    delete selectedSeats[key];
    document.querySelectorAll('[data-qty="' + key + '"]').forEach(i => { i.value = cart[key] || 0; });
    renderCartBar();
  }
  function bindQty(container) {
    container.querySelectorAll('.qty button').forEach(btn => {
      btn.addEventListener('click', () => {
        const max = btn.dataset.max ? parseInt(btn.dataset.max, 10) : 99;
        changeQty(btn.dataset.key, parseInt(btn.dataset.d, 10), max);
      });
    });
  }

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

  // Datums-Bausteine für die Event-Kachel (Tag / Monat / Wochentag / Uhrzeit)
  function dateParts(iso) {
    if (!iso) return { day: '–', month: '', wd: '', time: '' };
    const d = new Date(iso);
    return {
      day: d.toLocaleDateString('de-AT', { day: '2-digit' }),
      month: d.toLocaleDateString('de-AT', { month: 'short' }).replace('.', ''),
      wd: d.toLocaleDateString('de-AT', { weekday: 'short' }).replace('.', ''),
      time: d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
    };
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
  // Reiter (LEVEL/YPSILON) verdrahten
  function setupClubTabs() {
    const tabs = document.querySelectorAll('#clubTabs .fx-tab');
    tabs.forEach(t => {
      const select = () => {
        if (!t.dataset.club) return;
        const club = t.dataset.club;
        if (SUBDOMAINS_LIVE && CLUB_HOSTS[club] && location.hostname.toLowerCase() !== CLUB_HOSTS[club]) {
          location.href = location.protocol + '//' + CLUB_HOSTS[club] + '/';
          return;
        }
        activeClub = club;
        tabs.forEach(x => {
          const on = x === t;
          x.classList.toggle('active', on);
          x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        renderEvents();
      };
      t.addEventListener('click', select);
      t.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
      });
    });
  }

  async function renderEvents() {
    const box = $('eventList');
    let evParam = null;
    try {
      eventsCache = await S.getEvents();
      // Direktlink auf ein einzelnes Event: ?event=ID (übersteuert die Reiter)
      evParam = new URLSearchParams(location.search).get('event');
    } catch (e) {
      box.innerHTML = '<div class="fx-empty"><h3>Shop nicht erreichbar</h3><p>' + esc(e.message) + '</p></div>';
      return;
    }

    // Zähler je Club aktualisieren
    CLUBS.forEach(c => {
      const el = document.querySelector('[data-count="' + c + '"]');
      if (el) el.textContent = eventsCache.filter(ev => clubOf(ev) === c).length;
    });

    // Welche Events zeigen? Direktlink > aktiver Reiter
    const list = evParam
      ? eventsCache.filter(e => e.id === evParam)
      : eventsCache.filter(ev => clubOf(ev) === activeClub);

    const nameEl = $('clubName'); if (nameEl) nameEl.textContent = activeClub;
    const subEl = $('clubSub');
    if (subEl) subEl.textContent = list.length ? (list.length === 1 ? '1 Event' : list.length + ' Events') : '';

    if (!list.length) {
      box.innerHTML = '<div class="fx-empty"><h3>Keine Events</h3>' +
        '<p>Für ' + esc(activeClub) + ' sind aktuell keine Tickets im Verkauf – schau bald wieder vorbei.</p></div>';
      return;
    }

    box.innerHTML = list.map(ev => {
      const dp = dateParts(ev.date);
      const rows = ev.categories.filter(c => c.active).map(catRowHTML).join('');
      const desc = ev.description || '';
      const descShort = desc.length > 140 ? esc(desc.slice(0, 140)) + '…' : esc(desc);
      return '<article class="ev-card">' +
        '<div class="ev-open" data-open="' + esc(ev.id) + '" role="button" tabindex="0" title="Details anzeigen">' +
        '<div class="ev-banner' + (ev.imageUrl ? '' : ' ev-banner-ph') + '">' +
          (ev.imageUrl
            ? '<img src="' + esc(ev.imageUrl) + '" alt="" loading="lazy">'
            : '<img class="ev-ph-logo" src="assets/img/focus-logo.png" alt="Focus Events" loading="lazy">') +
        '</div>' +
        '<div class="ev-top">' +
          '<div class="ev-date"><div class="d">' + dp.day + '</div><div class="m">' + esc(dp.month) + '</div>' +
          '<div class="wd">' + esc(dp.wd) + (dp.time ? ' · ' + dp.time : '') + '</div></div>' +
          '<div class="ev-head"><h3>' + esc(ev.name) + '</h3>' +
          (ev.club || ev.location ? '<span class="ev-loc">' + esc(ev.club || ev.location) + '</span>' : '') +
          '<span class="ev-more">Details ansehen →</span>' +
          '</div>' +
        '</div>' +
        (desc ? '<p class="ev-desc">' + descShort + '</p>' : '') +
        '</div>' +
        '<div class="ev-cats">' + rows + '</div>' +
      '</article>';
    }).join('');

    bindQty(box);
    box.querySelectorAll('.ev-open').forEach(el => {
      el.addEventListener('click', () => openEventDetail(el.dataset.open));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEventDetail(el.dataset.open); } });
    });
  }

  // Detail-/Großansicht eines Events
  function openEventDetail(id) {
    const ev = eventsCache.find(e => e.id === id);
    if (!ev) return;
    const dp = dateParts(ev.date);
    // Kein eigenes Bild -> Focus-Logo als Platzhalter (wie auf der Kachel)
    $('detailBanner').innerHTML = ev.imageUrl
      ? '<img src="' + esc(ev.imageUrl) + '" alt="">'
      : '<img class="ev-ph-logo" src="assets/img/focus-logo.png" alt="Focus Events">';
    $('detailBanner').className = 'ev-detail-banner' + (ev.imageUrl ? '' : ' ev-banner-ph');
    $('detailBanner').style.display = '';
    $('detailTitle').textContent = ev.name;
    const meta = [];
    if (ev.date) meta.push('📅 ' + fmtDate(ev.date));
    if (ev.club || ev.location) meta.push('📍 ' + (ev.club || ev.location));
    $('detailMeta').textContent = meta.join('   ·   ');
    $('detailDesc').textContent = ev.description || '';
    $('detailDesc').style.display = ev.description ? '' : 'none';
    const cats = ev.categories.filter(c => c.active);
    $('detailCats').innerHTML = cats.length
      ? cats.map(catRowHTML).join('')
      : '<p class="sub">Für dieses Event sind aktuell keine Tickets verfügbar.</p>';
    bindQty($('detailCats'));
    openModal('eventDetailModal');
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
      $('seatMapArea').innerHTML = '<p class="sub" style="padding:24px 8px;color:var(--warn)">Für diese Ticketkategorie ist noch kein Sitzplan hinterlegt. Bitte wende dich an die Veranstalter.</p>';
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

    // Einen Tisch als runden Saalplan-Tisch rendern (Plätze im Kreis).
    function renderTable(t, tableSeats) {
      const n = tableSeats.length;
      const seatSize = 30;
      const R = n <= 1 ? 0 : Math.max(50, (seatSize + 12) / (2 * Math.sin(Math.PI / n)));
      const D = Math.round(2 * R + seatSize + 26);
      const c = D / 2;
      const seatsHtml = tableSeats.map((s, i) => {
        const ang = (-90 + i * (360 / n)) * Math.PI / 180;
        const x = Math.round(c + R * Math.cos(ang) - seatSize / 2);
        const y = Math.round(c + R * Math.sin(ang) - seatSize / 2);
        const sel = chosen.has(s.id);
        const cls = s.status !== 'free' ? 'taken' : (sel ? 'sel' : 'free');
        return '<button type="button" class="seat ' + cls + '" data-id="' + s.id + '"' +
          (s.status !== 'free' ? ' disabled' : '') +
          ' style="left:' + x + 'px;top:' + y + 'px" title="' + esc(seatLabel(s)) + '">' + s.seat + '</button>';
      }).join('');
      return '<div class="seat-table" style="width:' + D + 'px;height:' + D + 'px">' +
        '<div class="seat-table-label">Tisch<br>' + esc(t) + '</div>' + seatsHtml + '</div>';
    }

    // Sitz-Lookup nach Tisch/Platz (für den Layout-Saalplan)
    const seatByTS = {};
    seats.forEach(s => { seatByTS[s.table + '_' + s.seat] = s; });

    // --- Geometrie (identisch zum Saalplan-Editor) ---
    const SEAT = 26, OFF = 8;
    function spRound(n) {
      const R = n <= 1 ? 0 : Math.max(52, (SEAT + 12) / (2 * Math.sin(Math.PI / n)));
      const box = Math.round(2 * R + SEAT + 2 * OFF), surface = Math.round(2 * (R - SEAT / 2 - OFF)), c = box / 2, pos = [];
      for (let i = 0; i < n; i++) { const a = (-90 + i * (360 / n)) * Math.PI / 180; pos.push({ x: c + R * Math.cos(a) - SEAT / 2, y: c + R * Math.sin(a) - SEAT / 2 }); }
      return { box, surface, surfaceW: surface, surfaceH: surface, pos };
    }
    function seatOnRect(d, W, H, pad) {
      if (d < W) return { x: d, y: -pad }; d -= W;
      if (d < H) return { x: W + pad, y: d }; d -= H;
      if (d < W) return { x: W - d, y: H + pad }; d -= W;
      return { x: -pad, y: H - d };
    }
    function spRect(n) {
      const perSide = Math.ceil(n / 2), W = Math.max(90, perSide * 38), H = 76, pad = SEAT + OFF;
      const box = Math.max(W, H) + 2 * pad, ox = (box - W) / 2, oy = (box - H) / 2, P = 2 * (W + H), pos = [];
      for (let i = 0; i < n; i++) { const p = seatOnRect((i + 0.5) / n * P, W, H, pad); pos.push({ x: ox + p.x - SEAT / 2, y: oy + p.y - SEAT / 2 }); }
      return { box, surfaceW: W, surfaceH: H, pos };
    }
    function tableBox(t) {
      const n = Math.max(1, parseInt(t.seats, 10) || 1);
      return (t.shape === 'rect') ? spRect(n).box : spRound(n).box;
    }
    function floorTable(t, left, top) {
      const n = Math.max(1, parseInt(t.seats, 10) || 1);
      const g = (t.shape === 'rect') ? spRect(n) : spRound(n);
      const seatsHtml = g.pos.map((p, i) => {
        const seat = seatByTS[t.no + '_' + (i + 1)];
        const free = seat && seat.status === 'free';
        const sel = seat && chosen.has(seat.id);
        const cls = free ? (sel ? 'sel' : 'free') : 'taken';
        return '<button type="button" class="seat ' + cls + '"' + (seat ? ' data-id="' + seat.id + '"' : '') +
          (free ? '' : ' disabled') + ' style="left:' + Math.round(p.x) + 'px;top:' + Math.round(p.y) + 'px"' +
          ' title="' + esc((t.label ? 'Tisch ' + t.label + ' · ' : '') + 'Platz ' + (i + 1)) + '">' + (i + 1) + '</button>';
      }).join('');
      const sw = (t.shape === 'rect') ? g.surfaceW : g.surface, sh = (t.shape === 'rect') ? g.surfaceH : g.surface;
      return '<div class="fl-table ' + (t.shape === 'rect' ? 'rect' : 'round') + '" style="left:' + Math.round(left) + 'px;top:' + Math.round(top) + 'px;width:' + g.box + 'px;height:' + g.box + 'px">' +
        '<div class="fl-surface" style="width:' + sw + 'px;height:' + sh + 'px">' + esc(t.label || '') + '</div>' + seatsHtml + '</div>';
    }
    function renderFloor(layout) {
      const tables = (layout.tables || []), zones = (layout.zones || []);
      // Auf den tatsächlich genutzten Bereich zoomen (statt der ganzen Editor-Fläche)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      tables.forEach(t => { const bx = tableBox(t); minX = Math.min(minX, t.x); minY = Math.min(minY, t.y); maxX = Math.max(maxX, t.x + bx); maxY = Math.max(maxY, t.y + bx); });
      zones.forEach(z => { minX = Math.min(minX, z.x); minY = Math.min(minY, z.y); maxX = Math.max(maxX, z.x + z.w); maxY = Math.max(maxY, z.y + z.h); });
      if (!isFinite(minX)) { minX = 0; minY = 0; maxX = (layout.canvas && layout.canvas.w) || 1600; maxY = (layout.canvas && layout.canvas.h) || 1040; }
      const pad = 28; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const cw = maxX - minX, ch = maxY - minY;
      const areaW = $('seatMapArea').clientWidth || 900;
      const maxH = Math.round((window.innerHeight || 800) * 0.72);
      let scale = Math.min(areaW / cw, maxH / ch);
      scale = Math.max(0.3, Math.min(scale, 1.8));
      const zonesHtml = zones.map(z =>
        '<div class="fl-zone ' + esc(z.type || 'stage') + '" style="left:' + Math.round(z.x - minX) + 'px;top:' + Math.round(z.y - minY) + 'px;width:' + z.w + 'px;height:' + z.h + 'px">' + esc(z.label || '') + '</div>').join('');
      const tablesHtml = tables.map(t => floorTable(t, t.x - minX, t.y - minY)).join('');
      return '<div class="seat-floor-wrap" style="width:' + Math.round(cw * scale) + 'px;height:' + Math.round(ch * scale) + 'px">' +
        '<div class="seat-floor" style="width:' + cw + 'px;height:' + ch + 'px;transform:scale(' + scale + ')">' + zonesHtml + tablesHtml + '</div></div>';
    }

    function render() {
      $('seatCount').textContent = chosen.size + ' / ' + need + ' gewählt';
      $('btnSeatConfirm').disabled = chosen.size !== need;
      const layout = line.ev.layout;
      if (layout && Array.isArray(layout.tables) && layout.tables.length) {
        $('seatMapArea').innerHTML = renderFloor(layout);
      } else {
        $('seatMapArea').innerHTML = '<div class="seat-plan">' +
          '<div class="seat-stage">Bühne · Tanzfläche</div>' +
          Object.keys(rows).map(r =>
            '<div class="seat-row"><div class="seat-row-label">Reihe ' + esc(r) + '</div>' +
            '<div class="seat-tables">' + Object.keys(rows[r]).map(t =>
              renderTable(t, rows[r][t])
            ).join('') + '</div></div>').join('') +
          '</div>';
      }
      $('seatMapArea').querySelectorAll('.seat.free, .seat.sel').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.id;
          if (chosen.has(id)) chosen.delete(id);
          else { if (chosen.size >= need) return; chosen.add(id); }
          render();
        });
      });
    }
    $('btnSeatConfirm').onclick = () => {
      if (chosen.size !== need) return;
      doneCb(Array.from(chosen));
      closeModal('seatModal');
    };
    openModal('seatModal');
    render();
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
      const res = await S.startCheckout(items, '/index.html');
      cart = {}; selectedSeats = {};
      // Order-ID merken, um bei Abbruch das Kontingent sofort wieder freizugeben.
      try { localStorage.setItem('fx_pending_order', res.order_id); } catch (_) {}
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
      // Offene Bestellung sofort stornieren -> Kontingent wieder frei.
      let pend = null;
      try { pend = localStorage.getItem('fx_pending_order'); localStorage.removeItem('fx_pending_order'); } catch (_) {}
      if (pend) { await S.releaseOpenOrder(pend); }
      msg($('shopMsg'), 'Die Zahlung wurde abgebrochen – es wurden keine Tickets gekauft.', 'info');
      renderEvents(); // Verfügbarkeit aktualisieren
      return;
    }
    const orderId = params.get('order');
    if (params.get('paid') !== '1' || !orderId) return;
    try { localStorage.removeItem('fx_pending_order'); } catch (_) {}
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
      box.innerHTML = '<h3 class="mt-h">Deine Tickets, immer dabei</h3>' +
        '<p class="sub">Melde dich mit deiner E-Mail-Adresse an – deine Tickets erscheinen hier mit QR-Code fürs Handy.</p>' +
        '<p style="margin-top:18px"><button class="btn btn-gold" onclick="openLogin()">Jetzt anmelden</button></p>';
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
    const hostClub = clubFromHost();
    if (hostClub) { activeClub = hostClub; syncClubTabs(); }
    setupClubTabs();
    await renderEvents();
    renderCartBar();
    renderMyTickets();
    handlePaymentReturn();
  }
  init();
})();
