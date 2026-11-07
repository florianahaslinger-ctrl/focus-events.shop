// Birdie Tickets (CORE-Plattform) – Supabase "Send Email Hook"
// Supabase ruft diese Funktion für jede Auth-E-Mail auf; wir verschicken sie
// über die Brevo-API (HTTPS) mit deutscher Vorlage und 6-stelligem Code.
// Signaturprüfung nach dem Standard-Webhooks-Verfahren.

const HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET")!; // Format: v1,whsec_<base64>
const BREVO_KEY = Deno.env.get("BREVO_API_KEY")!;
const SENDER_EMAIL = Deno.env.get("SENDER_EMAIL") ?? "office@core-management.at";
const SENDER_NAME = Deno.env.get("SENDER_NAME") ?? "Birdie Tickets";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verify(body: string, headers: Headers): Promise<boolean> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const secretB64 = HOOK_SECRET.replace(/^v1,whsec_/, "").replace(/^whsec_/, "");
  const key = await crypto.subtle.importKey(
    "raw", b64ToBytes(secretB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  const expected = bytesToB64(mac);
  // Header kann mehrere "v1,<sig>" enthalten (leerzeichengetrennt)
  for (const part of sigHeader.split(" ")) {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    if (timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

// Marke der Login-Mail anhand der Seite, von der die Anmeldung kommt
// (gemeinsames Backend für Birdie Tickets, Focus Events und Litec Ball).
function brandFor(redirect: string) {
  const r = redirect.toLowerCase();
  if (r.includes("focus-events") || r.includes("focus.core-management.at")) {
    return { name: "Focus Events", title: "FOCUS EVENTS", tag: "Club Events", shop: "Focus Events Ticketshop",
      bg: "#080808", panel: "#101010", text: "#F5F0EB", muted: "#999999", accent: "#5a66ff", codeBg: "#0d0d0d" };
  }
  if (r.includes("litecball") || r.includes("litec")) {
    return { name: "Litec Ball", title: "LITEC BALL", tag: "The Wolf of Paul Hahn Street", shop: "Litec Ball Ticketshop",
      bg: "#080808", panel: "#101010", text: "#F5F0EB", muted: "#999999", accent: "#12a05f", codeBg: "#0d0d0d" };
  }
  return { name: "Birdie Tickets", title: "BIRDIE TICKETS", tag: "Tickets für Bälle &amp; Events", shop: "Birdie Tickets Ticketshop",
    bg: "#1F3D2B", panel: "#264A35", text: "#E8DCC4", muted: "#B5AC97", accent: "#8B5CF6", codeBg: "#1A3425" };
}

function buildEmail(email: string, d: Record<string, string>) {
  const token = d.token ?? "";
  const type = d.email_action_type ?? "magiclink";
  const redirect = d.redirect_to ?? d.site_url ?? "https://core-management.at";
  const verifyUrl = `${SUPABASE_URL}/auth/v1/verify?token=${encodeURIComponent(d.token_hash)}` +
    `&type=${encodeURIComponent(type)}&redirect_to=${encodeURIComponent(redirect)}`;
  const b = brandFor(redirect);

  const subject = type === "recovery"
    ? `Passwort zurücksetzen – ${b.name}`
    : `Dein Anmelde-Code – ${b.name}`;
  const intro = type === "recovery"
    ? "Hier ist dein Code, um dein Passwort zurückzusetzen:"
    : `Hier ist dein Anmelde-Code für den ${b.shop}:`;

  const html =
`<!DOCTYPE html><html><body style="margin:0;background:${b.bg};font-family:Arial,Helvetica,sans-serif;color:${b.text};padding:28px">
  <div style="max-width:480px;margin:0 auto;background:${b.panel};border:1px solid ${b.accent}40;border-radius:6px;padding:32px">
    <div style="font-size:22px;letter-spacing:3px;color:${b.accent};font-weight:bold;margin-bottom:6px">${b.title}</div>
    <div style="color:${b.muted};font-size:13px;margin-bottom:22px">${b.tag}</div>
    <p style="font-size:15px;line-height:1.6">${esc(intro)}</p>
    <div style="font-size:38px;letter-spacing:12px;font-weight:bold;color:${b.accent};text-align:center;
                background:${b.codeBg};border:1px dashed ${b.accent};border-radius:4px;padding:18px;margin:20px 0">${esc(token)}</div>
    <p style="font-size:13px;color:${b.muted};line-height:1.6">Der Code ist 10 Minuten gültig. Gib ihn im Ticketshop ein –
       oder <a href="${esc(verifyUrl)}" style="color:${b.accent}">hier klicken, um dich direkt anzumelden</a>.</p>
    <p style="font-size:12px;color:${b.muted};margin-top:22px">Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.</p>
  </div>
</body></html>`;

  const text = `${intro}\n\n    ${token}\n\nDer Code ist 10 Minuten gültig. ` +
    `Direkt anmelden: ${verifyUrl}\n\nWenn du das nicht angefordert hast, ignoriere diese E-Mail.`;
  return { subject, html, text, senderName: b.name };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.text();
  if (!(await verify(body, req.headers))) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  let payload: { user: { email: string }; email_data: Record<string, string> };
  try { payload = JSON.parse(body); } catch { return new Response("Bad payload", { status: 400 }); }

  const email = payload.user?.email;
  if (!email) return new Response("No recipient", { status: 400 });
  const { subject, html, text, senderName } = buildEmail(email, payload.email_data || {});

  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_KEY, "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      sender: { name: senderName, email: SENDER_EMAIL },
      to: [{ email }],
      subject, htmlContent: html, textContent: text,
    }),
  });
  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => "");
    console.error("Brevo error", resp.status, errTxt);
    // Supabase soll den Fehler sehen und ggf. dem Nutzer melden
    return new Response(JSON.stringify({ error: { http_code: resp.status, message: "E-Mail-Versand fehlgeschlagen" } }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
});
