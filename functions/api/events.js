/* Focus Events – öffentliche Events-API (nur lesen)
   GET /api/events            alle kommenden Events
   GET /api/events?club=LEVEL nur ein Club (LEVEL | YPSILON)
   GET /api/events?limit=5    maximal 5 Events (1–100)

   Liefert ausschließlich Daten, die auch im Shop öffentlich sichtbar sind –
   keine E-Mail-Adressen, Bestellungen, Umsätze oder Ticket-Designs.
   Antworten werden 60 Sekunden zwischengespeichert. */

const SUPA_URL = 'https://xfdiuhmgkdujbjhdhvcw.supabase.co';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhmZGl1aG1na2R1amJqaGRodmN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzNDI5MzUsImV4cCI6MjA5ODkxODkzNX0.HKKSNdNuIQXxh00LqvRFQciFMeF6oXrvvj-Gl9EaqmY'; // öffentlicher Schlüssel (steht auch im Shop-Code)
const SHOP_URL = 'https://focus-events.shop/index.html';
const CLUBS = ['LEVEL', 'YPSILON'];
const CACHE_SECONDS = 60;
// Ein Event bleibt bis 12 Stunden nach Beginn sichtbar (läuft z. B. noch in der Nacht).
const KEEP_AFTER_START_MS = 12 * 60 * 60 * 1000;

const EVENT_COLUMNS = 'id,name,date,location,club,description,image_url,shared_quota,show_availability,vip_enabled,' +
  'categories(id,name,description,price,quota,active,sort,pricing_mode,active_phase,' +
  'category_phases(name,price,ends_at,ends_qty,sort))';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function supa(path) {
  const res = await fetch(SUPA_URL + '/rest/v1/' + path, {
    headers: { apikey: SUPA_ANON, Authorization: 'Bearer ' + SUPA_ANON },
  });
  if (!res.ok) throw new Error('Datenbank antwortet mit ' + res.status);
  return res.json();
}

// Gleiche Logik wie im Shop und im Checkout: manuelle Phase > automatisch (Datum/Menge).
function currentPhase(cat, sold, now) {
  if (cat.pricing_mode !== 'phased') return null;
  const phases = (cat.category_phases || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
  if (!phases.length) return null;
  const manual = cat.active_phase;
  if (manual != null && manual >= 0 && manual < phases.length) return phases[manual];
  for (const p of phases) {
    const endedByDate = p.ends_at && now >= new Date(p.ends_at).getTime();
    const endedByQty = p.ends_qty != null && Number(sold) >= Number(p.ends_qty);
    if (!(endedByDate || endedByQty)) return p;
  }
  return phases[phases.length - 1];
}

function mapEvent(e, soldByCat, soldByEvent, now) {
  const shared = e.shared_quota == null ? null : Number(e.shared_quota);
  const sharedLeft = shared == null ? null : Math.max(0, shared - (soldByEvent[e.id] || 0));
  const showAvailability = e.show_availability !== false;

  const categories = (e.categories || [])
    .filter(c => c.active)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map(c => {
      const sold = soldByCat[c.id] || 0;
      const phase = currentPhase(c, sold, now);
      const left = shared == null ? Math.max(0, Number(c.quota) - sold) : sharedLeft;
      const out = {
        name: c.name,
        description: c.description || null,
        price: Number(phase ? phase.price : c.price),
        phase: phase ? phase.name : null,
        sold_out: left <= 0,
      };
      // Restmenge nur, wenn sie beim Event auch im Shop angezeigt wird.
      if (showAvailability) out.available = left;
      return out;
    });

  const open = categories.filter(c => !c.sold_out);
  return {
    id: e.id,
    name: e.name,
    date: e.date,
    location: e.location || null,
    club: e.club || null,
    description: e.description || null,
    image_url: e.image_url || null,
    ticket_url: SHOP_URL + '?event=' + encodeURIComponent(e.id),
    tickets_online: categories.length > 0,   // false = nur Abendkasse
    sold_out: categories.length > 0 && open.length === 0,
    price_from: open.length ? Math.min(...open.map(c => c.price)) : null,
    currency: 'EUR',
    vip_tables: !!e.vip_enabled,
    categories,
  };
}

async function loadEvents(club, limit) {
  const now = Date.now();
  const from = new Date(now - KEEP_AFTER_START_MS).toISOString();
  let query = 'events?select=' + encodeURIComponent(EVENT_COLUMNS) +
    '&storefront=eq.focus&active=eq.true&vip_club_default=not.is.true' +
    '&date=gte.' + encodeURIComponent(from) + '&order=date.asc&limit=' + limit;
  if (club) query += '&club=eq.' + club;
  const rows = await supa(query);

  const eventIds = rows.map(e => e.id);
  const catIds = rows.flatMap(e => (e.categories || []).map(c => c.id));
  const [catSold, evSold] = await Promise.all([
    catIds.length ? supa('category_sold?select=category_id,sold&category_id=in.(' + catIds.join(',') + ')') : [],
    eventIds.length ? supa('event_sold?select=event_id,sold&event_id=in.(' + eventIds.join(',') + ')') : [],
  ]);
  const soldByCat = Object.fromEntries(catSold.map(s => [s.category_id, s.sold]));
  const soldByEvent = Object.fromEntries(evSold.map(s => [s.event_id, s.sold]));
  const events = rows.map(e => mapEvent(e, soldByCat, soldByEvent, now));
  return { updated_at: new Date(now).toISOString(), count: events.length, events };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  const club = (url.searchParams.get('club') || '').trim().toUpperCase();
  if (club && !CLUBS.includes(club)) {
    return json({ error: 'Unbekannter Club. Erlaubt: ' + CLUBS.join(', ') }, 400, 'no-store');
  }
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return json({ error: 'limit muss eine Zahl von 1 bis 100 sein.' }, 400, 'no-store');
  }

  // Einheitlicher Cache-Schlüssel, damit fremde Parameter den Cache nicht umgehen.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(url.origin + '/api/events?club=' + club + '&limit=' + limit);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    const body = await loadEvents(club, limit);
    const res = json(body, 200, 'public, max-age=' + CACHE_SECONDS);
    if (cache && context.waitUntil) context.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    console.error('events-api', e);
    return json({ error: 'Events sind gerade nicht verfügbar.' }, 502, 'no-store');
  }
}
