// CORE Management Ticketshop – Stripe-Webhook
// Verifiziert die Stripe-Signatur und schaltet Bestellungen nach bezahlter
// Checkout-Session frei (Tickets werden erst hier erzeugt).
//
// Zusätzlich (best effort, blockiert NIE die Zahlungsbestätigung):
//  - checkout.session.completed: Buchung sofort in stripe_balance_txns
//    ablegen – inkl. Aufteilung Service/Zahlung und echter Stripe-Gebühr.
//  - payout.paid (Ereignis eines verbundenen Kontos): alle Buchungen dieser
//    Auszahlung als ausgezahlt markieren (payout_id, payout_at).
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Signaturgeheimnis des Plattform-Endpunkts (Zahlungen).
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
// Optional: Signaturgeheimnis des Connect-Endpunkts (Ereignisse der
// Veranstalterkonten, z. B. payout.paid). Fehlt es, werden nur Zahlungen
// verarbeitet – Auszahlungen bleiben dann bis zum nächsten CSV-Import offen.
const CONNECT_SECRET = Deno.env.get("STRIPE_CONNECT_WEBHOOK_SECRET") ?? "";
// Für Rückfragen an die Stripe-API (Gebühren, Auszahlungen).
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const c2 = (v: unknown) => (typeof v === "number" ? Math.round(v) / 100 : null);
const iso = (unix: unknown) => (typeof unix === "number" ? new Date(unix * 1000).toISOString() : null);

async function stripeGet(path: string, account?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE_KEY}` };
  if (account) headers["Stripe-Account"] = account;
  const r = await fetch("https://api.stripe.com/v1/" + path, { headers });
  if (!r.ok) throw new Error(`Stripe ${r.status} bei ${path.split("?")[0]}`);
  return await r.json();
}

/* Liest nach einer Zahlung die Kosten aus Stripe.
   Destination Charge: Die Bearbeitungsgebühr fällt auf dem Plattformkonto an,
   beim Veranstalter kommt eine eigene Zahlung (py_…) mit eigener
   Balance-Transaction an – genau die Zeile, die auch im Stripe-Bericht
   „Connected account – Itemized balance change“ steht. */
async function stripeCosts(paymentIntentId: string) {
  if (!STRIPE_KEY || !paymentIntentId) return null;
  try {
    const pi = await stripeGet("payment_intents/" + encodeURIComponent(paymentIntentId) +
      "?expand[]=latest_charge.balance_transaction&expand[]=latest_charge.transfer");
    const ch = pi?.latest_charge;
    if (!ch) return null;
    const bt = ch.balance_transaction;
    const amount = typeof ch.amount === "number" ? ch.amount : null;
    const appFee = typeof ch.application_fee_amount === "number" ? ch.application_fee_amount : 0;

    // Seite des Veranstalters (nur bei Destination Charge vorhanden)
    let dest: Record<string, unknown> | null = null;
    const tr = ch.transfer;
    if (tr && typeof tr === "object" && tr.destination_payment && tr.destination) {
      try {
        const pay = await stripeGet("charges/" + encodeURIComponent(tr.destination_payment) +
          "?expand[]=balance_transaction", tr.destination);
        const dbt = pay?.balance_transaction;
        if (dbt && typeof dbt === "object") {
          dest = {
            balance_transaction_id: dbt.id,
            connected_account: tr.destination,
            source_id: tr.destination_payment,
            reporting_category: dbt.reporting_category ?? "charge",
            created_at: iso(dbt.created),
            available_on: iso(dbt.available_on),
            gross: c2(dbt.amount), fee: c2(dbt.fee), net: c2(dbt.net),
            currency: dbt.currency ?? "eur",
          };
        }
      } catch (e) {
        console.error("Veranstalter-Buchung nicht lesbar:", (e as Error).message);
      }
    }
    return {
      fee: bt ? c2(bt.fee) : null,               // was Stripe real berechnet hat
      net: bt ? c2(bt.net) : null,
      payout: amount !== null ? c2(amount - appFee) : null,
      dest,
    };
  } catch (e) {
    console.error("Stripe-Kosten nicht lesbar:", (e as Error).message);
    return null;
  }
}

/* Bestellung zu einer Veranstalter-Buchung finden.
   Beim Kauf liegt die Balance-Transaction oft noch nicht vor – die Buchung
   kommt dann erst mit der Auszahlung und muss hier zugeordnet werden.
   1) resolveViaStripe: py_ (Veranstalter) -> Transfer -> Plattform-Charge -> PaymentIntent
   2) resolveViaMatch (Rückfall): gleicher Betrag, gleiche Gebühr (= Service + Zahlung),
      nächstliegende Zahlung innerhalb von 10 s und keine weitere innerhalb von 30 s. */
async function resolveViaStripe(admin: ReturnType<typeof createClient>, account: string, b: any) {
  try {
    const src = typeof b.source === "string" ? b.source : b.source?.id;
    if (src && src.startsWith("py_")) {
      const py = await stripeGet("charges/" + encodeURIComponent(src), account);
      const trId = typeof py.source_transfer === "string" ? py.source_transfer : py.source_transfer?.id;
      if (trId) {
        const tr = await stripeGet("transfers/" + encodeURIComponent(trId));
        const chId = typeof tr.source_transaction === "string" ? tr.source_transaction : tr.source_transaction?.id;
        if (chId) {
          const ch = await stripeGet("charges/" + encodeURIComponent(chId) + "?expand[]=balance_transaction");
          const pi = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id;
          if (pi) {
            const { data } = await admin.from("orders").select("id,service_fee,payment_fee")
              .eq("stripe_payment_intent", pi).maybeSingle();
            if (data) {
              const sbt = ch.balance_transaction;
              return { ...data, stripe_fee: sbt && typeof sbt === "object" ? c2(sbt.fee) : null };
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("Zuordnung über Stripe:", (e as Error).message);
  }
  return null;
}

// Nur nacheinander aufrufen – sonst könnten zwei Buchungen dieselbe Bestellung wählen.
async function resolveViaMatch(admin: ReturnType<typeof createClient>, b: any) {
  const gross = c2(b.amount), fee = c2(b.fee);
  if (gross === null || fee === null || typeof b.created !== "number") return null;
  const from = new Date((b.created - 60) * 1000).toISOString();
  const to = new Date((b.created + 60) * 1000).toISOString();
  const { data: cands } = await admin.from("orders").select("id,service_fee,payment_fee,paid_at")
    .eq("status", "bezahlt").eq("total", gross).gte("paid_at", from).lte("paid_at", to);
  const hits = (cands ?? [])
    .filter((o: any) => Math.round((Number(o.service_fee || 0) + Number(o.payment_fee || 0)) * 100) === Math.round(fee * 100))
    .map((o: any) => ({ o, dt: Math.abs(Date.parse(o.paid_at) / 1000 - b.created) }))
    .sort((x: any, y: any) => x.dt - y.dt);
  if (!hits.length || hits[0].dt > 10 || (hits[1] && hits[1].dt <= 30)) return null;
  const best = hits[0].o;
  const { count } = await admin.from("stripe_balance_txns").select("balance_transaction_id", { count: "exact", head: true })
    .eq("order_id", best.id);
  return count ? null : { id: best.id, service_fee: best.service_fee, payment_fee: best.payment_fee, stripe_fee: null };
}

/* payout.paid eines Veranstalterkontos: alle enthaltenen Buchungen markieren.
   Fehlt eine Buchung (z. B. Zahlung vor Einführung dieser Funktion), wird sie
   aus der Balance-Transaction angelegt – die Tabelle heilt sich so selbst.
   Buchungen ohne Bestellung werden anschließend zugeordnet und aufgeteilt. */
async function syncPayout(admin: ReturnType<typeof createClient>, account: string, payout: any) {
  let starting = "";
  let n = 0;
  const toLink: any[] = [];
  for (let page = 0; page < 50; page++) {
    const list = await stripeGet("balance_transactions?payout=" + encodeURIComponent(payout.id) +
      "&limit=100" + (starting ? "&starting_after=" + encodeURIComponent(starting) : ""), account);
    const rows = (list.data ?? [])
      .filter((b: any) => b.type !== "payout")
      .map((b: any) => ({
        balance_transaction_id: b.id,
        connected_account: account,
        source_id: typeof b.source === "string" ? b.source : b.source?.id ?? null,
        reporting_category: b.reporting_category ?? null,
        created_at: iso(b.created),
        available_on: iso(b.available_on),
        gross: c2(b.amount), fee: c2(b.fee), net: c2(b.net),
        currency: b.currency ?? "eur",
        payout_id: payout.id,
        payout_at: iso(payout.arrival_date),
        source: "webhook",
      }));
    if (rows.length) {
      // merge: vorhandene Aufteilung/Verknüpfung bleibt erhalten
      const { error } = await admin.from("stripe_balance_txns")
        .upsert(rows, { onConflict: "balance_transaction_id" });
      if (error) throw new Error(error.message);
      n += rows.length;
      // Welche Zahlungen sind noch keiner Bestellung zugeordnet?
      const charges = (list.data ?? []).filter((b: any) => b.type !== "payout" && b.reporting_category === "charge");
      if (charges.length) {
        const { data: known } = await admin.from("stripe_balance_txns")
          .select("balance_transaction_id,order_id,archive_id")
          .in("balance_transaction_id", charges.map((b: any) => b.id));
        const linked = new Set((known ?? []).filter((k: any) => k.order_id || k.archive_id)
          .map((k: any) => k.balance_transaction_id));
        charges.forEach((b: any) => { if (!linked.has(b.id)) toLink.push(b); });
      }
    }
    if (!list.has_more || !list.data?.length) break;
    starting = list.data[list.data.length - 1].id;
  }

  // Zuordnen – je Zeile ein eigenes Update, damit vorhandene Werte anderer
  // Zeilen nie überschrieben werden.
  let linkedNow = 0;
  const save = async (b: any, o: any) => {
    const { error } = await admin.from("stripe_balance_txns").update({
      order_id: o.id, service_fee: o.service_fee ?? null, payment_fee: o.payment_fee ?? null,
      split_source: "bestellung", ...(o.stripe_fee !== null ? { stripe_fee: o.stripe_fee } : {}),
    }).eq("balance_transaction_id", b.id).is("order_id", null);
    if (error) console.error("Zuordnung speichern:", error.message);
    else linkedNow++;
  };
  // 1) Stripe-Kette: eindeutig über den PaymentIntent – 6 parallel (Zeitlimit).
  const rest: any[] = [];
  for (let i = 0; i < toLink.length; i += 6) {
    await Promise.all(toLink.slice(i, i + 6).map(async (b) => {
      const o = await resolveViaStripe(admin, account, b);
      if (o) await save(b, o); else rest.push(b);
    }));
  }
  // 2) Rückfall-Abgleich nacheinander.
  for (const b of rest) {
    const o = await resolveViaMatch(admin, b);
    if (o) await save(b, o);
  }
  if (toLink.length) console.log(`payout ${payout.id}: ${linkedNow}/${toLink.length} Buchungen zugeordnet`);
  return n;
}

function ticketCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const b = (o: number) => Array.from(rnd.slice(o, o + 4)).map((x) => chars[x % chars.length]).join("");
  return "CM-" + b(0) + "-" + b(4);
}

async function signatureValid(payload: string, header: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  const pairs = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = pairs.find(([k]) => k === "t")?.[1];
  const sigs = pairs.filter(([k]) => k === "v1").map(([, v]) => v);  // bei Secret-Rotation mehrere
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5 min Toleranz
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((v1) => {
    if (hex.length !== v1.length) return false;
    let diff = 0;                                   // Konstantzeit-Vergleich
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
    return diff === 0;
  });
}

const ok = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200 });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const payload = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  const valid = (await signatureValid(payload, sig, WEBHOOK_SECRET)) ||
                (await signatureValid(payload, sig, CONNECT_SECRET));
  if (!valid) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(payload);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  /* ---------- Auszahlung an einen Veranstalter ---------- */
  if (event.type === "payout.paid" && event.account) {
    if (!STRIPE_KEY) return ok({ received: true, skipped: "no stripe key" });
    try {
      const n = await syncPayout(admin, event.account, event.data.object);
      return ok({ received: true, payout: event.data.object.id, rows: n });
    } catch (e) {
      console.error("payout sync:", (e as Error).message);
      return new Response("payout sync failed", { status: 500 }); // Stripe wiederholt
    }
  }

  if (event.type !== "checkout.session.completed") return ok({ received: true });

  /* ---------- Zahlung abgeschlossen: Bestellung freischalten ---------- */
  const session = event.data.object;
  if (session.payment_status !== "paid") return ok({ received: true, ignored: "not paid" });
  const orderId = session.metadata?.order_id ?? session.client_reference_id;
  if (!orderId) return new Response("Missing order id", { status: 400 });

  const { data: order } = await admin.from("orders")
    .select("id,status,service_fee,payment_fee").eq("id", orderId).single();
  if (!order) return new Response("Order not found", { status: 404 });
  if (order.status === "bezahlt") return ok({ received: true, already: true });

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

  // Tatsächliche Stripe-Kosten nachschlagen (best effort, nie blockierend).
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

  // Buchung für die Auszahlungsübersicht ablegen (best effort).
  if (costs?.dest) {
    try {
      const row = {
        ...costs.dest,
        order_id: orderId,
        service_fee: order.service_fee ?? null,
        payment_fee: order.payment_fee ?? null,
        split_source: "bestellung",
        stripe_fee: costs.fee,
        source: "webhook",
      };
      const { error } = await admin.from("stripe_balance_txns")
        .upsert(row, { onConflict: "balance_transaction_id" });
      if (error) console.error("balance row:", error.message);
    } catch (e) {
      console.error("balance row:", (e as Error).message);
    }
  }

  return ok({ received: true, order: orderId, tickets: tickets.length });
});
