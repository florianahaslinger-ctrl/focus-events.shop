// CORE Management – Stripe Connect (Express) Onboarding je Veranstalter
// action "status": verbundenes Konto prüfen/aktualisieren (charges_enabled)
// action "link":   Konto anlegen (falls nötig) und Onboarding-Link zurückgeben
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
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
async function stripe(path: string, method: string, body?: string) {
  const resp = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message ?? ("Stripe " + resp.status));
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: userData, error: userErr } = await admin.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
    if (userErr || !userData?.user?.email) return json({ error: "Bitte anmelden." }, 401);
    const email = userData.user.email.toLowerCase();

    // Nur eingetragene Admins/Veranstalter dürfen ein Auszahlungskonto verbinden
    const { data: me } = await admin.from("admins").select("email,role,stripe_account_id,stripe_charges_enabled").eq("email", email).maybeSingle();
    if (!me) return json({ error: "Keine Berechtigung." }, 403);

    const { action } = (await req.json().catch(() => ({}))) as { action?: string };

    let acct = me.stripe_account_id as string | null;

    // Konto anlegen, wenn noch keines existiert und ein Link angefordert wird
    if (!acct && action === "link") {
      const created = await stripe("accounts", "POST",
        "type=express&country=AT&email=" + encodeURIComponent(email) +
        "&capabilities[card_payments][requested]=true&capabilities[transfers][requested]=true");
      acct = created.id;
      await admin.from("admins").update({ stripe_account_id: acct }).eq("email", email);
    }

    // Aktuellen Status vom Stripe-Konto holen (falls vorhanden)
    let chargesEnabled = false;
    if (acct) {
      const a = await stripe("accounts/" + acct, "GET");
      chargesEnabled = !!a.charges_enabled;
      if (chargesEnabled !== me.stripe_charges_enabled) {
        await admin.from("admins").update({ stripe_charges_enabled: chargesEnabled }).eq("email", email);
      }
    }

    if (action === "link") {
      const ret = SHOP_URL + "/dashboard.html?stripe=return";
      const link = await stripe("account_links", "POST",
        "account=" + acct + "&type=account_onboarding" +
        "&refresh_url=" + encodeURIComponent(ret) + "&return_url=" + encodeURIComponent(ret));
      return json({ url: link.url, hasAccount: !!acct, chargesEnabled });
    }

    // Standard: nur Status
    return json({ hasAccount: !!acct, chargesEnabled });
  } catch (e) {
    const m = (e as Error).message || "";
    if (/platform.?profile|managing losses|responsibilities/i.test(m)) {
      return json({ error: "Die Zahlungsabwicklung ist noch nicht freigeschaltet. Bitte wende dich an CORE Management (office@core-management.at)." }, 503);
    }
    console.error(e);
    return json({ error: "Fehler bei der Stripe-Verbindung: " + m }, 500);
  }
});
