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
      return true;
    } catch (e) {
      msg(targetMsg, (code ? code + ': ' : '') + e.message, 'error');
      pushLog(false, (code || '') + ' – ' + e.message);
      return false;
    }
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
  }

  boot().catch(e => { msg($('ciGateErr'), 'Fehler beim Laden: ' + e.message, 'error'); });
})();
