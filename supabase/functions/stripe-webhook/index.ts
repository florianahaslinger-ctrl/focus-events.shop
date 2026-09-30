// CORE Management Ticketshop – Stripe-Webhook
// Verifiziert die Stripe-Signatur und schaltet Bestellungen nach bezahlter
// Checkout-Session frei (Tickets werden erst hier erzeugt).
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
// Fuer das Nachschlagen der tatsaechlichen Stripe-Kosten (optional -
// fehlt der Schluessel, laeuft alles Uebrige unveraendert weiter).
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

/* Holt die realen Kosten einer Zahlung aus Stripe.
   Destination Charge: die Bearbeitungsgebuehr faellt auf dem Plattformkonto
   an, der Betrag abzueglich application_fee geht an den Veranstalter.
   Schlaegt der Aufruf fehl, wird null geliefert - die Zahlungsbestaetigung
   darf davon NIE abhaengen. */
async function stripeCosts(paymentIntentId: string) {
  if (!STRIPE_KEY || !paymentIntentId) return null;
  try {
    const url = "https://api.stripe.com/v1/payment_intents/" +
      encodeURIComponent(paymentIntentId) +
      "?expand[]=latest_charge.balance_transaction";
    const r = await fetch(url, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
    if (!r.ok) return null;
    const pi = await r.json();
    const ch = pi?.latest_charge;
    if (!ch) return null;
    const bt = ch.balance_transaction;
    const c2 = (v: unknown) => (typeof v === "number" ? Math.round(v) / 100 : null);
    const amount = typeof ch.amount === "number" ? ch.amount : null;
    const appFee = typeof ch.application_fee_amount === "number" ? ch.application_fee_amount : 0;
    return {
      fee: bt ? c2(bt.fee) : null,
      net: bt ? c2(bt.net) : null,
      // An den Veranstalter ueberwiesen (Destination Charge).
      payout: amount !== null ? c2(amount - appFee) : null,
      paymentIntent: pi.id ?? paymentIntentId,
    };
  } catch (_) {
    return null;
  }
}

function ticketCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const b = (o: number) => Array.from(rnd.slice(o, o + 4)).map((x) => chars[x % chars.length]).join("");
  return "CM-" + b(0) + "-" + b(4);
}

async function verifySignature(payload: string, header: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts["t"], v1 = parts["v1"];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min Toleranz
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Konstantzeit-Vergleich
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const payload = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  if (!(await verifySignature(payload, sig))) {
    return new Response("Invalid signature", { status: 400 });
  }
  const event = JSON.parse(payload);
  if (event.type !== "checkout.session.completed") {
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }
  const session = event.data.object;
  if (session.payment_status !== "paid") {
    return new Response(JSON.stringify({ received: true, ignored: "not paid" }), { status: 200 });
  }
  const orderId = session.metadata?.order_id ?? session.client_reference_id;
  if (!orderId) return new Response("Missing order id", { status: 400 });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: order } = await admin.from("orders").select("id,status").eq("id", orderId).single();
  if (!order) return new Response("Order not found", { status: 404 });
  if (order.status === "bezahlt") {
    return new Response(JSON.stringify({ received: true, already: true }), { status: 200 });
  }

  const { data: items, error: itemsErr } = await admin.from("order_items")
    .select("category_id,event_name,category_name,price,qty,categories(seating,event_id,events(date,location))")
    .eq("order_id", orderId);
  if (itemsErr || !items?.length) {
    console.error("order_items fehlen für", orderId, itemsErr);
    return new Response("Order items missing", { status: 500 }); // Stripe wiederholt die Zustellung
  }

  const tickets: Record<string, unknown>[] = [];
  const seatedCodes: string[] = []; // Codes der Sitzkarten-Tickets (in Reihenfolge)
  for (const it of items ?? []) {
    const cats = it.categories as { seating?: boolean; events?: { date?: string; location?: string } } | null;
    const ev = cats?.events;
    for (let i = 0; i < it.qty; i++) {
      const code = ticketCode();
      tickets.push({
        code, order_id: orderId, category_id: it.category_id,
        event_name: it.event_name, event_date: ev?.date ?? null, event_location: ev?.location ?? null,
        category_name: it.category_name, price: it.price,
      });
      if (cats?.seating) seatedCodes.push(code);
    }
  }
  const { error: tErr } = await admin.from("tickets").insert(tickets);
  if (tErr) {
    console.error(tErr);
    return new Response("Ticket insert failed", { status: 500 });
  }

  // Reservierte Sitzplätze den Sitzkarten-Tickets zuweisen
  if (seatedCodes.length) {
    const { data: holds } = await admin.from("seat_holds").select("seat_id").eq("order_id", orderId);
    const seatIds = (holds ?? []).map((h) => h.seat_id);
    for (let i = 0; i < seatedCodes.length && i < seatIds.length; i++) {
      await admin.from("tickets").update({ seat_id: seatIds[i] }).eq("code", seatedCodes[i]);
    }
    await admin.from("seat_holds").delete().eq("order_id", orderId);
  }

  // Tatsaechliche Stripe-Kosten nachschlagen (best effort, nie blockierend).
  const piId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? "";
  const costs = await stripeCosts(piId);

  const upd: Record<string, unknown> = {
    status: "bezahlt", paid_via: "stripe", paid_at: new Date().toISOString(),
    stripe_session_id: session.id,
  };
  if (piId) upd.stripe_payment_intent = piId;
  if (costs) {
    if (costs.fee !== null) upd.stripe_fee = costs.fee;
    if (costs.net !== null) upd.stripe_net = costs.net;
    if (costs.payout !== null) upd.stripe_payout = costs.payout;
  }
  await admin.from("orders").update(upd).eq("id", orderId);

  return new Response(JSON.stringify({ received: true, order: orderId, tickets: tickets.length }), { status: 200 });
});
