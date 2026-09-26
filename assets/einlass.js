/* =========================================================
   Focus Events – Einlass-Scanner (einlass.js)
   Eigenständige, abgespeckte Seite: Login nur per Einlass-
   Passwort (pro Ball), danach ausschließlich QR-Check-in.
   Kein Zugriff auf Umsätze, Bestellungen oder Einstellungen.
   ========================================================= */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const S = window.CMStore;

  function msg(el, text, type) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (type ? ' ' + type : '') + (text ? ' show' : '');
  }

  const params = new URLSearchParams(location.search);
  const eventId = params.get('event');
  let pw = '';            // Einlass-Passwort (nur im Speicher)
  let eventName = '';
  const SKEY = 'cm_einlass_' + (eventId || '');

  /* ---------------- Login ---------------- */
  async function tryLogin(password, silent) {
    const res = await S.verifyCheckinPassword(eventId, password);
    if (!res || !res.ok) {
      if (res && res.reason === 'disabled') throw new Error('Für diesen Ball ist der Einlass-Scanner nicht aktiviert.');
      throw new Error('Falsches Passwort.');
    }
    pw = password;
    eventName = res.event || 'Einlass';
    try { sessionStorage.setItem(SKEY, password); } catch (e) {}
    $('ciGate').style.display = 'none';
    $('ciScan').style.display = '';
    $('ciScanEvent').textContent = eventName;
    $('ciEventName').textContent = eventName;
    $('ciEventName').style.display = '';
    $('ciLogout').style.display = '';
    if (!silent) msg($('scanMsg'), 'Angemeldet. Scanner bereit.', 'ok');
    loadGuests();
  }

  function logout() {
    try { sessionStorage.removeItem(SKEY); } catch (e) {}
    pw = '';
    scanStop();
    location.reload();
  }

  /* ---------------- Check-in-Kern ---------------- */
  const logEntries = [];
  function pushLog(ok, text) {
    logEntries.unshift({ ok, text, at: new Date() });
    $('ciLog').innerHTML = logEntries.slice(0, 25).map(e =>
      '<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.06)">' +
      '<span style="color:' + (e.ok ? 'var(--gold-light)' : '#e57373') + '">' + (e.ok ? '✓' : '✕') + '</span>' +
      '<span style="flex:1">' + text2html(e.text) + '</span>' +
      '<span class="hint">' + e.at.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</span>' +
      '</div>').join('');
  }
  function text2html(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  async function doCheckin(code, targetMsg) {
    try {
      const r = await S.checkInWithPassword(eventId, pw, code);
      const info = r.code + ' – ' + r.category + (r.seat ? ' · ' + r.seat : '') + ' (' + r.email + ')';
      msg(targetMsg, '✓ Eingecheckt: ' + info, 'ok');
      pushLog(true, info);
      showFlash('ok', 'Eingecheckt', r.category + (r.seat ? ' · ' + r.seat : '') + '\n' + r.email);
      return true;
    } catch (e) {
      msg(targetMsg, (code ? code + ': ' : '') + e.message, 'error');
      pushLog(false, (code || '') + ' – ' + e.message);
      // „Bereits eingecheckt" gelb (kein echter Fehler), sonst rot.
      const already = /bereits|schon/i.test(e.message);
      showFlash(already ? 'warn' : 'err', already ? 'Bereits eingecheckt' : 'Ungültig', e.message);
      return false;
    }
  }

  /* ---------------- Vollbild-Rückmeldung ---------------- */
  let flashTimer = null, audioCtx = null;
  const FLASH_STYLE = {
    ok:   { bg: 'rgba(20,120,52,.97)',  icon: '✓' },
    warn: { bg: 'rgba(190,120,10,.97)',  icon: '!' },
    err:  { bg: 'rgba(170,26,32,.97)',   icon: '✕' }
  };
  function beep(kind) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const seq = kind === 'ok' ? [[880, 0]] : kind === 'warn' ? [[440, 0], [440, 0.16]] : [[220, 0], [180, 0.18]];
      seq.forEach(([f, t]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'square'; o.frequency.value = f;
        o.connect(g); g.connect(audioCtx.destination);
        const t0 = audioCtx.currentTime + t;
        g.gain.setValueAtTime(0.001, t0);
        g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
        o.start(t0); o.stop(t0 + 0.15);
      });
    } catch (e) {}
  }
  function showFlash(kind, title, info) {
    const box = $('scanFlash'); if (!box) return;
    const s = FLASH_STYLE[kind] || FLASH_STYLE.ok;
    box.style.background = s.bg;
    $('scanFlashIcon').textContent = s.icon;
    $('scanFlashTitle').textContent = title || '';
    $('scanFlashInfo').textContent = info || '';
    box.style.display = 'flex';
    try { if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 90 : [70, 60, 70]); } catch (e) {}
    beep(kind);
    if (flashTimer) clearTimeout(flashTimer);
    // Erfolg kurz, Fehler etwas länger stehen lassen.
    flashTimer = setTimeout(hideFlash, kind === 'ok' ? 1400 : 2400);
  }
  function hideFlash() {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    const box = $('scanFlash'); if (box) box.style.display = 'none';
  }

  /* ---------------- Gästeliste (Suche + manueller Check-in) ---------------- */
  let guests = [];

  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadGuests() {
    if (!pw) return;
    msg($('glMsg'), 'Gästeliste wird geladen …', 'info');
    try {
      guests = await S.guestListWithPassword(eventId, pw);
      msg($('glMsg'), '');
      renderGuests();
    } catch (e) {
      msg($('glMsg'), e.message, 'error');
    }
  }

  function renderGuests() {
    const box = $('glList');
    const q = ($('glSearch').value || '').trim().toLowerCase();
    let list = guests;
    if (q) {
      list = guests.filter(g =>
        (g.customer_name || '').toLowerCase().includes(q) ||
        (g.email || '').toLowerCase().includes(q) ||
        (g.order_id || '').toLowerCase().includes(q) ||
        (g.tickets || []).some(t => (t.code || '').toLowerCase().includes(q)));
    }
    const totT = guests.reduce((n, g) => n + (g.tickets_total || 0), 0);
    const totC = guests.reduce((n, g) => n + (g.tickets_checked || 0), 0);
    $('glCount').textContent = guests.length
      ? totC + ' von ' + totT + ' Tickets eingecheckt · ' + list.length + ' von ' + guests.length + ' Bestellungen angezeigt'
      : '';
    if (!guests.length) { box.innerHTML = '<p class="sub">Noch keine bezahlten Bestellungen.</p>'; return; }
    if (!list.length) { box.innerHTML = '<p class="sub">Kein Treffer für „' + esc(q) + '“.</p>'; return; }
    // Bei leerer Suche nur die ersten 25 zeigen - sonst wird die Liste unbrauchbar lang.
    const shown = q ? list : list.slice(0, 25);
    box.innerHTML = shown.map(g => {
      const done = g.tickets_checked >= g.tickets_total;
      return '<div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.08)">' +
        '<div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">' +
          '<b style="font-size:1.05rem">' + esc(g.customer_name || '(kein Name)') + '</b>' +
          '<span class="hint">' + esc(g.email) + '</span>' +
          '<span style="margin-left:auto;color:' + (done ? 'var(--ok)' : 'var(--gold-light)') + '">' +
            g.tickets_checked + '/' + g.tickets_total + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' +
        (g.tickets || []).map(t => t.checked_in
          ? '<span style="padding:5px 9px;border:1px solid rgba(255,255,255,.14);opacity:.55;font-size:.78rem">✓ ' +
            esc(t.code) + ' · ' + esc(t.category) + '</span>'
          : '<button type="button" class="btn btn-ghost btn-sm gl-in" data-code="' + esc(t.code) + '" ' +
            'style="padding:5px 9px;font-size:.78rem">' + esc(t.code) + ' · ' + esc(t.category) + ' → einchecken</button>'
        ).join('') +
        '</div></div>';
    }).join('') +
    (!q && list.length > 25 ? '<p class="hint" style="margin-top:10px">… ' + (list.length - 25) +
      ' weitere. Bitte oben nach dem Namen suchen.</p>' : '');

    box.querySelectorAll('.gl-in').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      const ok = await doCheckin(b.dataset.code, $('glMsg'));
      if (ok) {
        // Lokal als eingecheckt markieren, damit die Liste sofort stimmt.
        guests.forEach(g => (g.tickets || []).forEach(t => {
          if (t.code === b.dataset.code && !t.checked_in) { t.checked_in = true; g.tickets_checked++; }
        }));
        renderGuests();
      } else { b.disabled = false; }
    }));
  }

  /* ---------------- QR-Scanner (Kamera + Foto) ---------------- */
  let scanStream = null, scanTimer = null, scanStart0 = 0;
  let lastScan = { code: '', at: 0 };
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

  function decode(source, sw, sh) {
    if (!window.jsQR) return null;
    const maxW = 1000;
    const scale = sw > maxW ? maxW / sw : 1;
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    scanCanvas.width = w; scanCanvas.height = h;
    scanCtx.drawImage(source, 0, 0, w, h);
    const img = scanCtx.getImageData(0, 0, w, h);
    const hit = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    return hit && hit.data ? hit.data : null;
  }

  async function scanHit(text) {
    const code = S.extractCode(text);
    const now = Date.now();
    if (code === lastScan.code && now - lastScan.at < 4000) return; // Entprellen
    lastScan = { code, at: now };
    const frame = $('scanFrame');
    const ok = await doCheckin(code, $('scanMsg'));
    if (frame) { frame.style.borderColor = ok ? '#4caf50' : '#e53935'; setTimeout(() => { frame.style.borderColor = ''; }, 800); }
  }

  async function scanStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg($('scanMsg'), 'Dieser Browser unterstützt keinen Live-Kamerazugriff (HTTPS erforderlich). Nutze „Foto scannen“.', 'error'); return;
    }
    if (!window.jsQR) { msg($('scanMsg'), 'Scanner-Bibliothek nicht geladen – bitte Seite neu laden.', 'error'); return; }
    try {
      msg($('scanMsg'), 'Kamera wird gestartet …', 'info');
      try {
        scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        scanStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      const video = $('scanVideo');
      video.srcObject = scanStream;
      await video.play().catch(() => {});
      $('scannerBox').style.display = '';
      $('btnScanStart').style.display = 'none';
      $('btnScanStop').style.display = '';
      msg($('scanMsg'), 'Scanner aktiv – QR-Code formatfüllend und ruhig ins Bild halten.', 'info');
      scanStart0 = Date.now();
      const loop = async () => {
        if (!scanStream) return;
        const video = $('scanVideo');
        if (video.readyState >= 2 && video.videoWidth) {
          const code = decode(video, video.videoWidth, video.videoHeight);
          if (code) { await scanHit(code); }
          else if (Date.now() - scanStart0 > 8000 && !/eingecheckt|bereits|nicht|falsch/i.test($('scanMsg').textContent)) {
            msg($('scanMsg'), 'Noch nichts erkannt: näher heran/scharfstellen, mehr Licht – oder „Foto scannen“ nutzen.', 'info');
          }
        }
        scanTimer = setTimeout(() => requestAnimationFrame(loop), 120);
      };
      requestAnimationFrame(loop);
    } catch (e) {
      msg($('scanMsg'), 'Kamera nicht verfügbar: ' + e.message + ' – nutze „Foto scannen“.', 'error');
      scanStop();
    }
  }

  function scanStop() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    const box = $('scannerBox'); if (box) box.style.display = 'none';
    if ($('btnScanStart')) $('btnScanStart').style.display = '';
    if ($('btnScanStop')) $('btnScanStop').style.display = 'none';
  }

  async function scanPhoto(file) {
    if (!file) return;
    if (!window.jsQR) { msg($('scanMsg'), 'Scanner-Bibliothek nicht geladen – bitte Seite neu laden.', 'error'); return; }
    msg($('scanMsg'), 'Foto wird ausgewertet …', 'info');
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const code = decode(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
      if (!code) { msg($('scanMsg'), 'Kein QR-Code im Foto erkannt – bitte näher/schärfer fotografieren.', 'error'); return; }
      await scanHit(code);
    } catch (e) {
      msg($('scanMsg'), 'Foto konnte nicht ausgewertet werden: ' + e.message, 'error');
    }
  }

  /* ---------------- Start ---------------- */
  async function boot() {
    await S.init();
    if (!eventId) {
      $('ciGateForm').style.display = 'none';
      msg($('ciGateErr'), 'Ungültiger Einlass-Link – es fehlt die Ball-Kennung. Bitte den Link von der Ball-Leitung erneut anfordern.', 'error');
      return;
    }
    // Bereits in dieser Sitzung angemeldet?
    let saved = '';
    try { saved = sessionStorage.getItem(SKEY) || ''; } catch (e) {}
    if (saved) { try { await tryLogin(saved, true); } catch (e) { try { sessionStorage.removeItem(SKEY); } catch (_) {} } }

    $('btnCiLogin').addEventListener('click', async () => {
      const val = $('ciPw').value.trim();
      if (!val) { msg($('ciGateMsg'), 'Bitte das Passwort eingeben.', 'error'); return; }
      $('btnCiLogin').disabled = true;
      try { await tryLogin(val, false); }
      catch (e) { msg($('ciGateMsg'), e.message, 'error'); }
      finally { $('btnCiLogin').disabled = false; }
    });
    $('ciPw').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnCiLogin').click(); });
    $('ciLogout').addEventListener('click', e => { e.preventDefault(); logout(); });

    $('btnScanStart').addEventListener('click', scanStart);
    $('btnScanStop').addEventListener('click', scanStop);
    $('btnScanPhoto').addEventListener('click', () => $('scanPhoto').click());
    $('scanPhoto').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; scanPhoto(f); });
    $('btnCiCheck').addEventListener('click', async () => {
      const code = $('ciCode').value.trim();
      if (!code) { msg($('ciCodeMsg'), 'Bitte einen Ticketcode eingeben.', 'error'); return; }
      const ok = await doCheckin(code, $('ciCodeMsg'));
      if (ok) $('ciCode').value = '';
    });
    $('ciCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnCiCheck').click(); });
    if ($('scanFlash')) $('scanFlash').addEventListener('click', hideFlash);
    if ($('glSearch')) $('glSearch').addEventListener('input', renderGuests);
    if ($('btnGlReload')) $('btnGlReload').addEventListener('click', loadGuests);
  }

  boot().catch(e => { msg($('ciGateErr'), 'Fehler beim Laden: ' + e.message, 'error'); });
})();
