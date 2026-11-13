// Konten anlegen (Benutzername + Passwort). Anmelden läuft direkt über Supabase Auth.
// Neue Konten nur mit Einladungscode – hier steht nur dessen SHA-256, nicht der Code selbst.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const INVITE_SHA256 = "3e6c51ace7ca3855078f0f5c88b48b2b8d405038b8beb0051263b067ebf92100";
const DOMAIN = "konto.invalid";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function sha256(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* leer */ }
  if (b.action !== "register") return json({ error: "Unbekannte Aktion" }, 400);

  const user = String(b.user ?? "").trim().toLowerCase();
  const pass = String(b.pass ?? "");
  const code = String(b.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(user)) return json({ error: "Benutzername: 3–32 Zeichen, nur a–z, 0–9, . _ -" }, 400);
  if (pass.length < 8) return json({ error: "Passwort: mindestens 8 Zeichen" }, 400);
  if (await sha256(code) !== INVITE_SHA256) { await sleep(1500); return json({ error: "Einladungscode falsch" }, 403); }

  const r = await fetch(SB_URL + "/auth/v1/admin/users", {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: "Bearer " + SERVICE, "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${user}@${DOMAIN}`, password: pass, email_confirm: true, user_metadata: { username: user } }),
  });
  if (r.ok) return json({ ok: true });
  const t = await r.text();
  if (r.status === 422 && /already|exists|registered/i.test(t)) return json({ error: "Benutzername ist schon vergeben" }, 409);
  if (/weak|password/i.test(t)) return json({ error: "Passwort zu schwach" }, 400);
  return json({ error: "Konto konnte nicht angelegt werden (" + r.status + ")" }, 502);
});
