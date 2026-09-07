// CORE Management Ticketshop – Tickets als Admin ausstellen
// Nur für Admins: erzeugt eine Bestellung + Tickets (ohne Stripe) und
// verschickt sie per Brevo an eine beliebige E-Mail-Adresse.
//  - mode "gast": Gratis-Gastticket (kein Umsatz)
//  - mode "bar":  manuell als bezahlt erfasst (zählt als Umsatz, z. B. Barzahlung)
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BREVO_KEY = Deno.env.get("BREVO_API_KEY")!;
const SENDER_EMAIL = Deno.env.get("SENDER_EMAIL") ?? "office@core-management.at";
const SENDER_NAME = Deno.env.get("SENDER_NAME") ?? "CORE Management";
const SHOP_URL = Deno.env.get("SHOP_URL") ?? "https://core-management.at";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function ticketCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const b = (o: number) => Array.from(rnd.slice(o, o + 4)).map((x) => chars[x % chars.length]).join("");
  return "CM-" + b(0) + "-" + b(4);
}
function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const fmtEUR = (n: number) => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(n);
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("de-AT", { weekday: "short", day: "2-digit", month: "long", year: "numeric" }) +
    " · " + d.toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    const email = u?.user?.email?.toLowerCase();
    if (!email) return json({ error: "Bitte anmelden." }, 401);
    const { data: adm } = await admin.from("admins").select("email").eq("email", email).maybeSingle();
    if (!adm) return json({ error: "Keine Admin-Berechtigung." }, 403);

    const body = await req.json() as {
      category_id: string; qty: number; email: string; mode?: string; note?: string;
    };
    const qty = Math.floor(Number(body.qty));
    const recipient = String(body.email || "").trim().toLowerCase();
    const mode = body.mode === "bar" ? "bar" : "gast";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient)) return json({ error: "Bitte eine gültige Empfänger-E-Mail angeben." }, 400);
    if (!Number.isFinite(qty) || qty < 1 || qty > 50) return json({ error: "Menge muss zwischen 1 und 50 liegen." }, 400);

    const { data: cat } = await admin
      .from("categories")
      .select("id,name,price,quota,seating,event_id,events(name,date,location)")
      .eq("id", body.category_id).maybeSingle();
    if (!cat) return json({ error: "Ticketkategorie nicht gefunden." }, 400);
    const ev = cat.events as { name: string; date: string; location: string };

    // Kontingent prüfen
    const { data: soldRow } = await admin.from("category_sold").select("sold").eq("category_id", cat.id).maybeSingle();
    const rest = (cat.quota ?? 0) - (soldRow?.sold ?? 0);
    if (qty > rest) return json({ error: `Nur noch ${Math.max(0, rest)} Tickets im Kontingent von „${cat.name}“.` }, 400);

    // Sitzkarten: freie Plätze automatisch zuweisen
    let freeSeatIds: string[] = [];
    if (cat.seating) {
      const { data: map } = await admin.rpc("seat_map", { p_event: cat.event_id });
      freeSeatIds = (map ?? []).filter((s: { status: string }) => s.status === "free")
        .slice(0, qty).map((s: { id: string }) => s.id);
      if (freeSeatIds.length < qty) {
        return json({ error: `Nicht genug freie Sitzplätze (nur ${freeSeatIds.length} frei).` }, 400);
      }
    }

    const unit = mode === "bar" ? Number(cat.price) : 0;
    const total = unit * qty;
    const orderId = "G" + Date.now().toString().slice(-8);

    const { error: oErr } = await admin.from("orders").insert({
      id: orderId, email: recipient, status: "bezahlt", total, paid_via: mode, paid_at: new Date().toISOString(),
    });
    if (oErr) throw oErr;
    await admin.from("order_items").insert({
      order_id: orderId, category_id: cat.id, event_name: ev.name, category_name: cat.name, price: unit, qty,
    });

    const tickets: Record<string, unknown>[] = [];
    for (let i = 0; i < qty; i++) {
      tickets.push({
        code: ticketCode(), order_id: orderId, category_id: cat.id,
        event_name: ev.name, event_date: ev.date, event_location: ev.location,
        category_name: cat.name, price: unit,
        seat_id: cat.seating ? (freeSeatIds[i] ?? null) : null,
      });
    }
    const { error: tErr } = await admin.from("tickets").insert(tickets);
    if (tErr) throw tErr;
    const codes = tickets.map((t) => t.code as string);

    // E-Mail an den/die Empfänger:in
    const note = (body.note || "").trim();
    const rows = codes.map((c) =>
      `<div style="margin:10px 0;padding:12px 14px;background:#0d0d0c;border:1px solid rgba(201,168,76,.3);border-radius:6px">
        <div style="font-family:Arial;font-size:20px;letter-spacing:3px;color:#E8C97A;font-weight:bold">${esc(c)}</div>
        <a href="${SHOP_URL}/ticket.html?c=${encodeURIComponent(c)}" style="color:#C9A84C;font-size:13px">Ticket anzeigen &amp; QR-Code</a>
      </div>`).join("");
    const html =
`<!DOCTYPE html><html><body style="margin:0;background:#080808;font-family:Arial,Helvetica,sans-serif;color:#F5F0EB;padding:28px">
  <div style="max-width:520px;margin:0 auto;background:#101010;border:1px solid rgba(201,168,76,0.25);border-radius:8px;padding:32px">
    <div style="font-size:22px;letter-spacing:3px;color:#C9A84C;font-weight:bold">CORE MANAGEMENT</div>
    <div style="color:#999;font-size:13px;margin-bottom:20px">Events &amp; Entertainment Austria</div>
    <p style="font-size:16px">Du hast ${qty} Ticket${qty > 1 ? "s" : ""} erhalten:</p>
    <p style="font-size:15px;color:#E8C97A;margin:2px 0 2px">${esc(cat.name)} – ${esc(ev.name)}</p>
    <p style="font-size:13px;color:#999;margin:0 0 4px">${esc(fmtDate(ev.date))}${ev.location ? " · " + esc(ev.location) : ""}</p>
    ${note ? `<p style="font-size:14px;color:#ccc;background:rgba(201,168,76,.08);border-left:3px solid #C9A84C;padding:10px 12px;border-radius:4px">${esc(note)}</p>` : ""}
    ${rows}
    <p style="font-size:13px;color:#999;line-height:1.6;margin-top:18px">
      Zeig den QR-Code beim Einlass (Link oben) oder nenne den Ticketcode.
      Alle Tickets ansehen und als <b>PDF</b> herunterladen: melde dich unter
      <a href="${SHOP_URL}/tickets.html" style="color:#C9A84C">${SHOP_URL.replace("https://", "")}/tickets.html</a>
      mit dieser E-Mail-Adresse an.
    </p>
  </div>
</body></html>`;
    const text = `Du hast ${qty} Ticket(s) erhalten: ${cat.name} – ${ev.name}\n${fmtDate(ev.date)}` +
      (note ? `\n\n${note}` : "") + `\n\nTicketcodes:\n` +
      codes.map((c) => `  ${c}  ->  ${SHOP_URL}/ticket.html?c=${c}`).join("\n") +
      `\n\nAlle Tickets & PDF: ${SHOP_URL}/tickets.html (Anmeldung mit dieser E-Mail).`;

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": BREVO_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        sender: { name: SENDER_NAME, email: SENDER_EMAIL }, to: [{ email: recipient }],
        subject: `Deine Tickets – ${ev.name}`, htmlContent: html, textContent: text,
      }),
    });
    const emailed = resp.ok;
    if (!emailed) console.error("Brevo error", resp.status, await resp.text().catch(() => ""));

    return json({ order_id: orderId, codes, total, emailed });
  } catch (e) {
    console.error(e);
    return json({ error: "Interner Fehler: " + (e as Error).message }, 500);
  }
});
