// CORE Management Ticketshop – Stripe-Checkout-Session anlegen
// Aufruf mit Supabase-Auth-JWT; legt Bestellung (offen) an und gibt die Stripe-URL zurück.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SHOP_URL = Deno.env.get("SHOP_URL") ?? "https://core-management.at";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: userData, error: userErr } = await admin.auth.getUser(
      authHeader.replace(/^Bearer\s+/i, ""),
    );
    if (userErr || !userData?.user?.email) {
      return json({ error: "Bitte zuerst mit E-Mail anmelden." }, 401);
    }
    const email = userData.user.email.toLowerCase();

    const { items, return_path } = await req.json() as {
      items: { category_id: string; qty: number; seat_ids?: string[] }[];
      return_path?: string;
    };
    if (!Array.isArray(items) || !items.length) {
      return json({ error: "Der Warenkorb ist leer." }, 400);
    }

    // Rückkehr-Seite nach der Zahlung: nur bekannte Shop-Seiten erlauben.
    // "/tickets.html" = klassischer Shop (Standard), "/shop/" = weiße Version.
    const RETURN_PATHS: Record<string, string> = {
      "/tickets.html": SHOP_URL + "/tickets.html",
      "/shop/": SHOP_URL + "/shop/index.html",
    };
    const returnUrl = RETURN_PATHS[return_path ?? ""] ?? RETURN_PATHS["/tickets.html"];

    // Kategorien + Event + Verfügbarkeit prüfen
    const ids = items.map((i) => i.category_id);
    const { data: cats, error: catErr } = await admin
      .from("categories")
      .select("id,name,price,quota,max_per_order,active,seating,event_id,events(name,date,location,active,shared_quota)")
      .in("id", ids);
    if (catErr) throw catErr;

    const { data: sold } = await admin.from("category_sold").select("category_id,sold").in("category_id", ids);
    const soldMap = new Map((sold ?? []).map((s) => [s.category_id, s.sold]));

    let subtotal = 0;
    let totalTickets = 0;
    const orderItems: Record<string, unknown>[] = [];
    const lineItems: string[] = [];
    const allSeatIds: string[] = [];
    const eventIds = new Set<string>();
    let li = 0;
    for (const it of items) {
      const cat = (cats ?? []).find((c) => c.id === it.category_id);
      const ev = cat?.events as { name: string; date: string; location: string; active: boolean; shared_quota: number | null } | null;
      const qty = Math.floor(Number(it.qty));
      if (!cat || !cat.active || !ev?.active) return json({ error: "Eine Ticketkategorie ist nicht mehr verfügbar." }, 400);
      if (!Number.isFinite(qty) || qty < 1 || qty > cat.max_per_order) {
        return json({ error: `Ungültige Menge für „${cat.name}“ (max. ${cat.max_per_order}).` }, 400);
      }
      // Pro-Kategorie-Kontingent nur prüfen, wenn KEIN Gesamtkontingent aktiv ist.
      // Bei aktivem Gesamtkontingent greift die gemeinsame Prüfung nach der Schleife.
      if (ev.shared_quota === null || ev.shared_quota === undefined) {
        const rest = cat.quota - (soldMap.get(cat.id) ?? 0);
        if (qty > rest) return json({ error: `Für „${cat.name}“ sind nur noch ${Math.max(0, rest)} Tickets verfügbar.` }, 400);
      }
      // Sitzplätze: für Sitzkarten müssen genau qty gültige Plätze gewählt sein
      if (cat.seating) {
        const seatIds = Array.isArray(it.seat_ids) ? it.seat_ids : [];
        if (seatIds.length !== qty) {
          return json({ error: `Bitte genau ${qty} Sitzplatz/Sitzplätze für „${cat.name}“ wählen.` }, 400);
        }
        const { data: seatRows } = await admin.from("seats").select("id").eq("event_id", cat.event_id).in("id", seatIds);
        if (!seatRows || seatRows.length !== seatIds.length) {
          return json({ error: "Ein gewählter Sitzplatz gehört nicht zu diesem Event." }, 400);
        }
        allSeatIds.push(...seatIds);
      }
      eventIds.add(cat.event_id as string);
      subtotal += Number(cat.price) * qty;
      totalTickets += qty;
      orderItems.push({
        category_id: cat.id, event_name: ev.name, category_name: cat.name, price: cat.price, qty,
        _seating: !!cat.seating, _seatIds: cat.seating ? (it.seat_ids ?? []) : [],
        _eventDate: ev.date ?? null, _eventLocation: ev.location ?? null,
      });
      const cents = Math.round(Number(cat.price) * 100);
      lineItems.push(
        `line_items[${li}][price_data][currency]=eur` +
        `&line_items[${li}][price_data][product_data][name]=${encodeURIComponent(cat.name + " – " + ev.name)}` +
        `&line_items[${li}][price_data][unit_amount]=${cents}` +
        `&line_items[${li}][quantity]=${qty}`,
      );
      li++;
    }

    // Mandanten-Regel: eine Bestellung gehört zu genau einem Ball (für getrennte Auszahlungen)
    if (eventIds.size !== 1) {
      return json({ error: "Bitte pro Bestellung nur Tickets eines Balls auswählen." }, 400);
    }
    const eventId = [...eventIds][0];

    // Event einmalig laden (Gesamtkontingent + Auszahlungskonto).
    const { data: evRow } = await admin.from("events")
      .select("owner_email,shared_quota,fees_on_organizer").eq("id", eventId).maybeSingle();
    // Gebühren-Modus: true = Veranstalter trägt die Gebühren, Kunde zahlt exakt den Ticketpreis.
    const feesOnOrganizer = evRow?.fees_on_organizer === true;

    // Gesamtkontingent (modular): ist es gesetzt, zählt der gemeinsame Topf über alle Kategorien.
    if (evRow?.shared_quota !== null && evRow?.shared_quota !== undefined) {
      const { data: es } = await admin.from("event_sold").select("sold").eq("event_id", eventId).maybeSingle();
      const alreadySold = es?.sold ?? 0;
      const restShared = Number(evRow.shared_quota) - alreadySold;
      if (totalTickets > restShared) {
        return json({ error: `Für diesen Ball sind nur noch ${Math.max(0, restShared)} Tickets verfügbar.` }, 400);
      }
    }

    // Gebühren: Servicegebühr (CORE) 3,5 % + 0,25 €/Ticket · Zahlungsgebühr (Stripe) 1,5 % + 0,25 €/Ticket
    const serviceFee = subtotal > 0 ? Math.round((0.035 * subtotal + 0.25 * totalTickets) * 100) / 100 : 0;
    const paymentFee = subtotal > 0 ? Math.round((0.015 * subtotal + 0.25 * totalTickets) * 100) / 100 : 0;
    // Kunde zahlt: bei feesOnOrganizer nur den Ticketpreis, sonst zzgl. Gebühren.
    const total = feesOnOrganizer
      ? subtotal
      : Math.round((subtotal + serviceFee + paymentFee) * 100) / 100;
    // Gebühren nur dann als eigene Positionen zeigen, wenn der Kunde sie trägt.
    if (!feesOnOrganizer && serviceFee > 0) {
      lineItems.push(`line_items[${li}][price_data][currency]=eur&line_items[${li}][price_data][product_data][name]=${encodeURIComponent("Servicegebühr")}&line_items[${li}][price_data][unit_amount]=${Math.round(serviceFee * 100)}&line_items[${li}][quantity]=1`);
      li++;
    }
    if (!feesOnOrganizer && paymentFee > 0) {
      lineItems.push(`line_items[${li}][price_data][currency]=eur&line_items[${li}][price_data][product_data][name]=${encodeURIComponent("Zahlungsgebühr")}&line_items[${li}][price_data][unit_amount]=${Math.round(paymentFee * 100)}&line_items[${li}][quantity]=1`);
      li++;
    }

    // Bestellung anlegen (offen)
    const orderId = "B" + Date.now().toString().slice(-8);
    const { error: oErr } = await admin.from("orders").insert({
      id: orderId, email, subtotal, service_fee: serviceFee, payment_fee: paymentFee, total,
      status: "offen", event_id: eventId,
    });
    if (oErr) throw oErr;
    const { error: iErr } = await admin.from("order_items").insert(
      orderItems.map((x) => ({
        order_id: orderId, category_id: x.category_id, event_name: x.event_name,
        category_name: x.category_name, price: x.price, qty: x.qty,
      })),
    );
    if (iErr) throw iErr;

    // Sitzplätze reservieren (atomar) – bei Konflikt Bestellung verwerfen
    if (allSeatIds.length) {
      const { error: holdErr } = await admin.rpc("hold_seats", { p_order: orderId, p_seats: allSeatIds, p_minutes: 30 });
      if (holdErr) {
        await admin.from("orders").delete().eq("id", orderId);
        return json({ error: (holdErr.message || "Sitzplatz nicht mehr verfügbar.").replace(/^.*?:\s*/, "") }, 409);
      }
    }

    // Gratis-Bestellung (0 €): keine Stripe-Zahlung – Tickets sofort erzeugen
    if (total === 0) {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const ticketCode = () => {
        const r = crypto.getRandomValues(new Uint8Array(8));
        const b = (o: number) => Array.from(r.slice(o, o + 4)).map((x) => chars[x % chars.length]).join("");
        return "CM-" + b(0) + "-" + b(4);
      };
      const tickets: Record<string, unknown>[] = [];
      for (const x of orderItems) {
        const seatIds = x._seating ? (x._seatIds as string[]) : [];
        for (let i = 0; i < (x.qty as number); i++) {
          tickets.push({
            code: ticketCode(), order_id: orderId, category_id: x.category_id,
            event_name: x.event_name, event_date: x._eventDate, event_location: x._eventLocation,
            category_name: x.category_name, price: x.price,
            seat_id: x._seating ? (seatIds[i] ?? null) : null,
          });
        }
      }
      const { error: tErr } = await admin.from("tickets").insert(tickets);
      if (tErr) { await admin.from("orders").delete().eq("id", orderId); throw tErr; }
      await admin.from("seat_holds").delete().eq("order_id", orderId);
      await admin.from("orders").update({
        status: "bezahlt", paid_via: "gratis", paid_at: new Date().toISOString(),
      }).eq("id", orderId);
      return json({ url: returnUrl + "?order=" + orderId + "&paid=1", order_id: orderId, free: true });
    }

    // Auszahlungskonto des Veranstalters ermitteln (Stripe Connect).
    // Bei zugewiesenem Veranstalter läuft die Zahlung auf dessen Konto,
    // deine Gebühr (Service + Zahlung) bleibt als application_fee bei CORE.
    // Ohne Veranstalter (CORE-eigenes Event) läuft alles wie bisher aufs Plattform-Konto.
    let connect = "";
    if (evRow?.owner_email) {
      const { data: owner } = await admin.from("admins")
        .select("stripe_account_id,stripe_charges_enabled").eq("email", evRow.owner_email).maybeSingle();
      if (!owner?.stripe_account_id || !owner.stripe_charges_enabled) {
        await admin.from("orders").delete().eq("id", orderId);
        if (allSeatIds.length) await admin.from("seat_holds").delete().eq("order_id", orderId);
        return json({ error: "Der Veranstalter hat die Zahlungsabwicklung noch nicht eingerichtet. Bitte später erneut versuchen." }, 409);
      }
      // CORE erhält Service + Zahlung als application_fee – unabhängig vom Gebühren-Modus.
      // Im Übernahme-Modus ist der Ladebetrag der reine Ticketpreis; die Gebühr darf ihn
      // nicht übersteigen, sonst lehnt Stripe ab (Veranstalter erhält dann Betrag − Gebühr).
      const totalCents = Math.round(total * 100);
      const feeCents = Math.min(Math.round((serviceFee + paymentFee) * 100), totalCents);
      connect = `&payment_intent_data[application_fee_amount]=${feeCents}` +
        `&payment_intent_data[transfer_data][destination]=${owner.stripe_account_id}`;
    }

    // Stripe Checkout Session – bei Sitzplätzen läuft die Session mit der
    // 30-Minuten-Reservierung ab, damit keine Doppelbelegung entstehen kann.
    const body =
      `mode=payment&client_reference_id=${orderId}` +
      `&customer_email=${encodeURIComponent(email)}` +
      `&metadata[order_id]=${orderId}` +
      connect +
      (allSeatIds.length ? `&expires_at=${Math.floor(Date.now() / 1000) + 30 * 60}` : "") +
      `&success_url=${encodeURIComponent(returnUrl + "?order=" + orderId + "&paid=1")}` +
      `&cancel_url=${encodeURIComponent(returnUrl + "?cancelled=1")}` +
      `&${lineItems.join("&")}`;
    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + STRIPE_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const session = await resp.json();
    if (!resp.ok) {
      console.error("Stripe error:", session);
      await admin.from("orders").update({ status: "storniert" }).eq("id", orderId);
      return json({ error: "Zahlung konnte nicht gestartet werden: " + (session?.error?.message ?? resp.status) }, 502);
    }
    await admin.from("orders").update({ stripe_session_id: session.id }).eq("id", orderId);
    return json({ url: session.url, order_id: orderId });
  } catch (e) {
    console.error(e);
    return json({ error: "Interner Fehler: " + (e as Error).message }, 500);
  }
});
