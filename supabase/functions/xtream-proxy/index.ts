// Proxy für die Web-Version von StreamTV (iPad, Laptop): holt Xtream-API, EPG und M3U-Listen
// stellvertretend ab – Safari blockiert diese Abfragen sonst (CORS, IPTV-Kennung).
// Nur für angemeldete Watchlist-Konten. Videos laufen NICHT hierüber, sondern direkt zum Anbieter.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "x-upstream-status, x-final-url",
};
const err = (msg: string, status: number) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const UA = "IPTVSmartersPlayer";

/** Keine internen Adressen (Schutz vor Missbrauch als Tür ins Supabase-Netz). */
function blockedHost(h: string): boolean {
  h = h.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".supabase.co")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h.includes(":");   // IPv6-Literale nicht erlaubt
}

const tokenCache = new Map<string, number>();
async function authorized(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const tok = auth.replace(/^Bearer\s+/i, "");
  if (!tok || tok.startsWith("sb_")) return false;
  const until = tokenCache.get(tok);
  if (until && until > Date.now()) return true;
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: req.headers.get("apikey") || SB_KEY, Authorization: "Bearer " + tok } });
  if (!r.ok) return false;
  await r.body?.cancel();
  tokenCache.set(tok, Date.now() + 5 * 60_000);
  if (tokenCache.size > 500) tokenCache.clear();
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return err("GET erwartet", 405);
  if (!await authorized(req)) return err("Watchlist-Anmeldung nötig", 401);

  let target: URL;
  try { target = new URL(new URL(req.url).searchParams.get("url") ?? ""); } catch { return err("url fehlt", 400); }
  if (!/^https?:$/.test(target.protocol) || blockedHost(target.hostname)) return err("Adresse nicht erlaubt", 400);

  let up: Response;
  try {
    up = await fetch(target, {
      headers: { "User-Agent": UA, Accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    return err("Anbieter nicht erreichbar: " + (e instanceof Error ? e.message : String(e)), 502);
  }
  const ct = up.headers.get("content-type") ?? "";
  // Videos gehören nicht hierher (Datenvolumen) – die Web-App spielt sie direkt ab
  if (/^video\/|mp2t/i.test(ct)) { await up.body?.cancel(); return err("Videos werden nicht weitergeleitet", 415); }
  const len = Number(up.headers.get("content-length") ?? 0);
  if (len > 120 * 1024 * 1024) { await up.body?.cancel(); return err("Antwort zu groß", 413); }

  return new Response(up.body, {
    status: up.status,
    headers: {
      ...cors,
      "Content-Type": ct || "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "x-upstream-status": String(up.status),
      "x-final-url": up.url,
    },
  });
});
