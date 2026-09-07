/* =========================================================
   Focus Events Ticketshop – PDF-Tickets (ticket-pdf.js)
   Erzeugt ohne externe Bibliotheken ein PDF (eine Seite pro
   Ticket) mit QR-Code und klassischem Ticketcode.
   Benötigt assets/qrcode.js (globale Funktion `qrcode`).
   ========================================================= */
(function (global) {
  'use strict';

  /* QR-Codes verlinken auf die Ticket-Status-Seite: beim Scannen mit einer
     normalen Handy-Kamera öffnet sich die Gültigkeitsprüfung, und der
     Einlass-Scanner im Dashboard liest den Code aus derselben URL. */
  function ticketUrl(code) {
    return 'https://focus-events.shop/ticket.html?c=' + encodeURIComponent(code);
  }

  /* --- QR-Code als Canvas rendern (gemeinsam mit Shop nutzbar) --- */
  function qrCanvas(text, sizePx) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2; // Ruhezone in Modulen
    const scale = Math.max(2, Math.floor(sizePx / (n + 2 * quiet)));
    const size = (n + 2 * quiet) * scale;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    }
    return cv;
  }

  /* --- PDF-Grundbausteine --- */

  // Typografische Zeichen, die in WinAnsi eigene Codes haben
  const WINANSI = {
    '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92,
    '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99
  };

  // Text in WinAnsi/Latin-1 kodieren und für PDF-Strings escapen
  function pdfText(s) {
    let out = '';
    for (const ch of String(s)) {
      let code = WINANSI[ch] || ch.codePointAt(0);
      if (code > 255) code = 63; // '?'
      if (code === 40 || code === 41 || code === 92) out += '\\' + ch;
      else if (code < 32 || code > 126) out += '\\' + code.toString(8).padStart(3, '0');
      else out += ch;
    }
    return out;
  }

  function dataURLtoBytes(dataURL) {
    const b64 = dataURL.split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  const latin1 = s => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  };

  /* Baut das PDF aus Objekten zusammen (Chunks: String oder Uint8Array) */
  function buildPDF(objects) {
    const chunks = [];
    const offsets = [0];
    let pos = 0;
    const push = c => {
      const b = typeof c === 'string' ? latin1(c) : c;
      chunks.push(b); pos += b.length;
    };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    objects.forEach((obj, i) => {
      offsets[i + 1] = pos;
      push((i + 1) + ' 0 obj\n');
      obj.forEach(push);
      push('\nendobj\n');
    });
    const xrefPos = pos;
    let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push('trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF');
    const total = new Uint8Array(pos);
    let o = 0;
    chunks.forEach(c => { total.set(c, o); o += c.length; });
    return total;
  }

  /* --- Layout einer Ticketseite (A4: 595 x 842 pt) --- */

  const GOLD = '0.027 0.624 0.588'; // #079f96
  const DARK = '0.045 0.045 0.045';
  const GRAY = '0.45 0.45 0.45';

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('de-AT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }

  function pageContent(t, order, imgName, idx, count, sponsorOps) {
    const eur = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });
    const line = (x, y, font, size, color, text) =>
      color + ' rg\nBT /' + font + ' ' + size + ' Tf ' + x + ' ' + y + ' Td (' + pdfText(text) + ') Tj ET\n';

    let s = '';
    // Kopfleiste
    s += DARK + ' rg\n0 762 595 80 re f\n';
    s += line(60, 800, 'F1', 22, GOLD, 'FOCUS EVENTS');
    s += line(60, 778, 'F2', 10, '0.7 0.7 0.7', 'Events & Entertainment Austria');
    s += line(455, 792, 'F1', 20, GOLD, 'TICKET');

    // Eventblock
    s += line(60, 700, 'F1', 21, '0 0 0', t.eventName);
    s += line(60, 674, 'F2', 12, GRAY, fmtDate(t.eventDate) + (t.eventLocation ? '  ·  ' + t.eventLocation : ''));

    // Kategorie & Preis
    s += GOLD + ' rg\n60 640 200 26 re f\n';
    s += line(70, 648, 'F1', 13, '0.08 0.06 0.02', t.categoryName);
    s += line(280, 648, 'F1', 13, '0 0 0', eur.format(t.price));

    // Sitzplatz (falls vorhanden)
    if (t.seat) {
      s += line(60, 616, 'F1', 13, GOLD, 'Sitzplatz: Reihe ' + t.seat.row + ' · Tisch ' + t.seat.table + ' · Platz ' + t.seat.seat);
    }

    // Bestelldaten
    s += line(60, 600, 'F2', 10, GRAY, 'Bestellung: ' + order.id + '   ·   ' + order.email);
    s += line(60, 584, 'F2', 10, GRAY, 'Bestellt am: ' + new Date(order.createdAt).toLocaleString('de-AT') +
      '   ·   Ticket ' + idx + ' von ' + count);
    s += line(60, 568, 'F2', 10, '0.18 0.5 0.25', 'Status: BEZAHLT');

    // QR-Code (rechts) mit Rahmen
    s += '0.85 0.85 0.85 RG 1 w\n351 331 198 198 re S\n';
    s += 'q 190 0 0 190 355 335 cm /' + imgName + ' Do Q\n';

    // Klassischer Ticketcode (altes System) – groß, links neben dem QR
    s += line(60, 480, 'F2', 10, GRAY, 'Ticketcode (manuelle Eingabe):');
    s += line(60, 448, 'F1', 26, '0 0 0', t.code);
    s += line(60, 400, 'F2', 9, GRAY, 'Beim Einlass QR-Code scannen lassen oder den Ticketcode');
    s += line(60, 387, 'F2', 9, GRAY, 'oben vorzeigen. Der QR-Code öffnet die Gültigkeitsprüfung auf');
    s += line(60, 374, 'F2', 9, GRAY, 'focus-events.shop/ticket.html – auch mit jeder Handy-Kamera.');

    // Trennlinie + Hinweise
    s += GOLD + ' RG 1.2 w\n60 300 m 535 300 l S\n';
    s += line(60, 278, 'F1', 10, '0 0 0', 'Wichtige Hinweise');
    const hints = [
      'Dieses Ticket ist nur einmal gültig und wird beim Einlass entwertet.',
      'Der Zutritt ist nur mit gültigem Ticket (QR-Code oder Ticketcode) möglich.',
      'Weitergabe nur inklusive dieses Dokuments; Kopien werden beim Einlass ungültig.',
      'Veranstalter: Focus Events · focus-events.shop'
    ];
    hints.forEach((h, i) => { s += line(60, 260 - i * 15, 'F2', 9, GRAY, '·  ' + h); });

    // Sponsoren-Band (unten, falls Logos vorhanden)
    if (sponsorOps) s += sponsorOps;

    return s;
  }

  /* --- Sponsor-Logos: laden, rastern (JPEG) und unten platzieren --- */

  // Lädt data-URL-Logos in Canvas → JPEG-Bytes + Seitenverhältnis.
  async function loadSponsorImages(logos) {
    const out = [];
    for (const src of (logos || [])) {
      if (!src || typeof src !== 'string') continue;
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
        const ar = img.naturalWidth / img.naturalHeight || 1;
        const hPx = Math.min(220, img.naturalHeight || 220);
        const wPx = Math.max(1, Math.round(hPx * ar));
        const cv = document.createElement('canvas');
        cv.width = wPx; cv.height = hPx;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, wPx, hPx); // weißer Grund (Ticket ist weiß)
        ctx.drawImage(img, 0, 0, wPx, hPx);
        const jpg = dataURLtoBytes(cv.toDataURL('image/jpeg', 0.9));
        out.push({ jpg, wPx: cv.width, hPx: cv.height, ar });
      } catch (e) { /* fehlerhaftes Logo überspringen */ }
    }
    return out;
  }

  // Platziert die Logos in einem automatischen, mehrzeiligen Raster unten
  // auf der Seite und liefert die PDF-Zeichenoperatoren (Bildnamen Sp0, Sp1, …).
  //
  // Vorgehen (überlappungsfrei, auch bei bis zu 25 Logos):
  //  1. Logos zeilenweise „einregalen" (shelf packing): bei Zielhöhe H werden
  //     Logos in eine Zeile gelegt, bis die Breite voll ist – dann neue Zeile.
  //  2. Per Binärsuche wird die GRÖSSTE Höhe H gesucht, bei der der gesamte
  //     Block (inkl. fester Zeilenabstände) noch ins untere Band passt. Das ist
  //     robust für jede Anzahl (1–25) und jedes Seitenverhältnis.
  //  3. Jede Zeile wird horizontal zentriert; sehr breite Einzel-Logos werden
  //     auf die Bandbreite geklemmt und in der Zeile vertikal zentriert.
  function sponsorOps(imgs) {
    if (!imgs.length) return '';
    const LEFT = 60, RIGHT = 535, ROW_W = RIGHT - LEFT; // 475 pt nutzbar
    const GAP_X = 20;        // horizontaler Abstand zwischen Logos
    const GAP_Y = 12;        // vertikaler Abstand zwischen Zeilen
    const H_MAX = 42;        // Ziel-/Maximalhöhe je Logo (pt) bei wenigen Logos
    const BAND_BOTTOM = 56;  // Unterkante des Logo-Bands
    const BAND_TOP_MAX = 178;// max. Oberkante der Logos (darüber bleibt Platz für die Überschrift)
    const BAND_H = BAND_TOP_MAX - BAND_BOTTOM;

    // Zeilen bei gegebener Höhe H packen. Liefert Zeilen mit Zellen {k, ar}.
    function pack(H) {
      const rows = []; let cur = []; let curW = 0;
      imgs.forEach((im, k) => {
        const w = Math.min(H * im.ar, ROW_W); // sehr breite Logos auf Bandbreite klemmen
        if (cur.length === 0) { cur = [{ k, ar: im.ar }]; curW = w; }
        else if (curW + GAP_X + w <= ROW_W) { cur.push({ k, ar: im.ar }); curW += GAP_X + w; }
        else { rows.push(cur); cur = [{ k, ar: im.ar }]; curW = w; }
      });
      if (cur.length) rows.push(cur);
      return rows;
    }

    // Binärsuche nach der größten Höhe, deren Block noch ins Band passt.
    // fits(H) ist praktisch monoton (kleinere Logos → weniger/niedrigere Zeilen).
    function fits(H) {
      const rows = pack(H);
      return rows.length * H + (rows.length - 1) * GAP_Y <= BAND_H;
    }
    let lo = 1, hi = H_MAX, H = 1;
    if (fits(H_MAX)) { H = H_MAX; }        // wenige Logos: volle Zielhöhe
    else {
      for (let i = 0; i < 34; i++) {       // sonst größtes passendes H suchen
        const mid = (lo + hi) / 2;
        if (fits(mid)) { H = mid; lo = mid; } else { hi = mid; }
      }
    }
    const rows = pack(H);
    const blockH = rows.length * H + (rows.length - 1) * GAP_Y;

    const yTopBlock = BAND_BOTTOM + blockH; // Oberkante des obersten Logos
    let ops = '';
    // Dezente Überschrift + Trennlinie oberhalb des Rasters
    ops += GOLD + ' RG 0.8 w\n' + LEFT + ' ' + (yTopBlock + 24) + ' m ' + RIGHT + ' ' + (yTopBlock + 24) + ' l S\n';
    ops += GRAY + ' rg\nBT /F2 8 Tf ' + LEFT + ' ' + (yTopBlock + 10) + ' Td (' + pdfText('MIT FREUNDLICHER UNTERSTÜTZUNG VON') + ') Tj ET\n';

    const R = rows.length;
    rows.forEach((row, r) => {
      // Zeile r von oben (0) nach unten; Unterkante dieser Zeile:
      const yLower = BAND_BOTTOM + (R - 1 - r) * (H + GAP_Y);
      const widths = row.map(c => Math.min(H * c.ar, ROW_W));
      const rowTotal = widths.reduce((a, b) => a + b, 0) + GAP_X * (row.length - 1);
      let x = LEFT + (ROW_W - rowTotal) / 2; // Zeile horizontal zentrieren
      row.forEach((c, i) => {
        let w = widths[i], h = H, y = yLower;
        if (w >= ROW_W && c.ar > ROW_W / H) { // überbreites Logo: Höhe reduzieren, vertikal zentrieren
          h = ROW_W / c.ar; y = yLower + (H - h) / 2;
        }
        ops += 'q ' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' cm /Sp' + c.k + ' Do Q\n';
        x += w + GAP_X;
      });
    });
    return ops;
  }

  /* --- Eigenes Ticket-Design (pro Event) ---
     Ist am Event ein custom_ticket hinterlegt ({front,back} als Bild-
     Data-URLs), wird das Ticket im Design des Veranstalters erzeugt und
     nur der individuelle QR-Code + Ticketcode darübergelegt. Seitenformat
     entspricht dem Design (Querformat), damit nichts verzerrt wird. */

  const CT_W = 595.276, CT_H = 204.094;   // Ticket-Design-Seitenmaß (pt)

  // Bild-Data-URL laden → JPEG-Bytes + Pixelmaße (für das PDF-XObject).
  async function loadFullImage(src) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const jpg = dataURLtoBytes(cv.toDataURL('image/jpeg', 0.9));
    return { jpg, wPx: cv.width, hPx: cv.height };
  }

  function imgObject(im) {
    return [
      '<< /Type /XObject /Subtype /Image /Width ' + im.wPx + ' /Height ' + im.hPx +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.jpg.length + ' >>\nstream\n',
      im.jpg, '\nendstream'
    ];
  }

  async function makeCustomPDF(order, tickets, ct) {
    const front = await loadFullImage(ct.front);
    const back = ct.back ? await loadFullImage(ct.back) : null;
    const objects = [];

    // Feste Grundobjekte: 1 Catalog, 2 Pages, 3 F1, 4 F2, 5 Front, (6 Back)
    const FRONT_OBJ = 5;
    const BACK_OBJ = back ? 6 : 0;
    const FIRST = back ? 7 : 6;
    const perTicket = back ? 5 : 3; // QR, Front-Content, Front-Page (+ Back-Content, Back-Page)

    // QR-Box oben rechts, über dem Einlass-Block
    const QS = 48, QX = 497, QY_TOP = 48;               // top-down
    const qyPdf = CT_H - (QY_TOP + QS);                 // bottom-up
    const BX = 491, BW = 60, BY_TOP = 44, BH = 66;
    const byPdf = CT_H - (BY_TOP + BH);

    const pageRefs = [];
    tickets.forEach((_t, i) => {
      const base = FIRST + i * perTicket;
      pageRefs.push((base + 2) + ' 0 R');               // Front-Seite
      if (back) pageRefs.push((base + 4) + ' 0 R');     // Rück-Seite
    });

    objects.push(['<< /Type /Catalog /Pages 2 0 R >>']);
    objects.push(['<< /Type /Pages /Kids [' + pageRefs.join(' ') + '] /Count ' + pageRefs.length + ' >>']);
    objects.push(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    objects.push(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
    objects.push(imgObject(front));
    if (back) objects.push(imgObject(back));

    const mediaBox = '[0 0 ' + CT_W.toFixed(3) + ' ' + CT_H.toFixed(3) + ']';

    tickets.forEach((t, i) => {
      const base = FIRST + i * perTicket;
      const qrObj = base;
      // QR-Bild für dieses Ticket
      const cv = qrCanvas(ticketUrl(t.code), 400);
      const jpg = dataURLtoBytes(cv.toDataURL('image/jpeg', 0.92));
      objects.push([
        '<< /Type /XObject /Subtype /Image /Width ' + cv.width + ' /Height ' + cv.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n',
        jpg, '\nendstream'
      ]);
      // Front-Content: Design-Bild + weiße QR-Box + QR + Ticketcode
      const code = pdfText(t.code);
      const codeW = t.code.length * 7.5 * 0.58;         // grobe Textbreite (Helvetica-Bold 7.5)
      const codeX = BX + Math.max(0, (BW - codeW) / 2);
      let fc = '';
      fc += 'q ' + CT_W.toFixed(2) + ' 0 0 ' + CT_H.toFixed(2) + ' 0 0 cm /Fr Do Q\n';
      fc += '1 1 1 rg ' + BX + ' ' + byPdf.toFixed(2) + ' ' + BW + ' ' + BH + ' re f\n';
      fc += '0.027 0.624 0.588 RG 0.8 w ' + BX + ' ' + byPdf.toFixed(2) + ' ' + BW + ' ' + BH + ' re S\n';
      fc += 'q ' + QS + ' 0 0 ' + QS + ' ' + QX + ' ' + qyPdf.toFixed(2) + ' cm /Qr Do Q\n';
      fc += '0.05 0.05 0.05 rg BT /F1 7.5 Tf ' + codeX.toFixed(2) + ' ' + (byPdf + 6).toFixed(2) + ' Td (' + code + ') Tj ET\n';
      objects.push(['<< /Length ' + latin1(fc).length + ' >>\nstream\n' + fc + '\nendstream']);
      // Front-Page
      objects.push([
        '<< /Type /Page /Parent 2 0 R /MediaBox ' + mediaBox +
        ' /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Fr ' + FRONT_OBJ + ' 0 R /Qr ' + qrObj + ' 0 R >> >> ' +
        '/Contents ' + (base + 1) + ' 0 R >>'
      ]);
      if (back) {
        const bc = 'q ' + CT_W.toFixed(2) + ' 0 0 ' + CT_H.toFixed(2) + ' 0 0 cm /Bk Do Q\n';
        objects.push(['<< /Length ' + latin1(bc).length + ' >>\nstream\n' + bc + '\nendstream']);
        objects.push([
          '<< /Type /Page /Parent 2 0 R /MediaBox ' + mediaBox +
          ' /Resources << /XObject << /Bk ' + BACK_OBJ + ' 0 R >> >> ' +
          '/Contents ' + (base + 3) + ' 0 R >>'
        ]);
      }
    });

    return buildPDF(objects);
  }

  /* --- Öffentliche API --- */

  async function makePDF(order, tickets, logos, customTicket) {
    // Eigenes Design pro Event hat Vorrang vor der Standardvorlage.
    if (customTicket && customTicket.front) {
      return makeCustomPDF(order, tickets, customTicket);
    }
    const objects = [];
    const pageRefs = [];
    // Sponsor-Logos einmalig laden (auf allen Seiten dieselben, als geteilte XObjects).
    const sponsors = await loadSponsorImages(logos || (order && order.sponsorLogos) || []);
    const spOps = sponsorOps(sponsors);
    // Objekt 1: Catalog, 2: Pages, 3: F1, 4: F2,
    // dann S geteilte Sponsor-Bilder, danach pro Ticket: QR-Bild, Inhalt, Seite.
    const SPONSOR_BASE = 5;                       // erstes Sponsor-Bildobjekt
    const FIRST_DYNAMIC = SPONSOR_BASE + sponsors.length;
    // Ressourcen-Eintrag für die geteilten Sponsor-Bilder (auf jeder Seite gültig)
    const spRes = sponsors.map((_s, k) => '/Sp' + k + ' ' + (SPONSOR_BASE + k) + ' 0 R').join(' ');

    tickets.forEach((t, i) => {
      const pageObj = FIRST_DYNAMIC + i * 3 + 2;
      pageRefs.push(pageObj + ' 0 R');
    });

    objects.push(['<< /Type /Catalog /Pages 2 0 R >>']);
    objects.push(['<< /Type /Pages /Kids [' + pageRefs.join(' ') + '] /Count ' + tickets.length + ' >>']);
    objects.push(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
    objects.push(['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);

    // Geteilte Sponsor-Bildobjekte
    sponsors.forEach((sp) => {
      objects.push([
        '<< /Type /XObject /Subtype /Image /Width ' + sp.wPx + ' /Height ' + sp.hPx +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + sp.jpg.length + ' >>\nstream\n',
        sp.jpg,
        '\nendstream'
      ]);
    });

    tickets.forEach((t, i) => {
      const imgObj = FIRST_DYNAMIC + i * 3;
      const cv = qrCanvas(ticketUrl(t.code), 400);
      const jpg = dataURLtoBytes(cv.toDataURL('image/jpeg', 0.92));
      objects.push([
        '<< /Type /XObject /Subtype /Image /Width ' + cv.width + ' /Height ' + cv.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpg.length + ' >>\nstream\n',
        jpg,
        '\nendstream'
      ]);
      const content = pageContent(t, order, 'Im' + i, i + 1, tickets.length, spOps);
      objects.push([
        '<< /Length ' + latin1(content).length + ' >>\nstream\n' + content + '\nendstream'
      ]);
      objects.push([
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Im' + i + ' ' + imgObj + ' 0 R ' + spRes + ' >> >> ' +
        '/Contents ' + (imgObj + 1) + ' 0 R >>'
      ]);
    });

    return buildPDF(objects);
  }

  let sponsorResolver = null; // async (eventId) => [dataURL, …]
  function setSponsorResolver(fn) { sponsorResolver = fn; }
  let customTicketResolver = null; // async (eventId) => { front, back } | null
  function setCustomTicketResolver(fn) { customTicketResolver = fn; }

  async function download(order, tickets, logos) {
    tickets = tickets || order.tickets;
    // Eigenes Ticket-Design (falls für das Event hinterlegt) nachladen.
    let customTicket = order && order.customTicket;
    if (!customTicket && customTicketResolver && order && order.eventId) {
      try { customTicket = await customTicketResolver(order.eventId); } catch (e) { customTicket = null; }
    }
    // Logos nur laden, wenn kein eigenes Design greift (dort sind Sponsoren bereits drauf).
    if (!logos && !(customTicket && customTicket.front)) {
      if (order && order.sponsorLogos) logos = order.sponsorLogos;
      else if (sponsorResolver && order && order.eventId) {
        try { logos = await sponsorResolver(order.eventId); } catch (e) { logos = []; }
      }
    }
    const bytes = await makePDF(order, tickets, logos, customTicket);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tickets-' + order.id + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  global.CMTicketPDF = { download, makePDF, qrCanvas, ticketUrl, setSponsorResolver, setCustomTicketResolver };
})(window);
