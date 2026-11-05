// Smarte Suche für StreamTV und TV-Launcher: freie Frage (getippt oder gesprochen) -> konkrete Titel.
// Der Anthropic-Schlüssel liegt nur als Secret ANTHROPIC_API_KEY im Supabase-Projekt.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `Du bist die Suche eines Fernsehers in Deutschland (Serien, Filme, Live-TV-Sender).
Der Nutzer tippt oder spricht eine Anfrage, oft ungenau, falsch geschrieben oder per Spracherkennung verhört.
Antworte NUR mit einem JSON-Objekt, ohne Text davor oder danach:
{"answer": "<ein kurzer deutscher Satz, was du zeigst>",
 "items": [{"title": "<offizieller Originaltitel>", "title_de": "<deutscher Titel, falls anders>", "year": <Jahr oder null>, "type": "tv"|"movie"}],
 "channels": ["<Name eines Live-TV-Senders>"]}
Regeln:
- Nennt der Nutzer einen konkreten Titel (auch verhört/falsch geschrieben), gib genau diesen zuerst zurück, ggf. plus 2-3 ähnliche.
- Beschreibt er eine Stimmung, ein Genre, Schauspieler, Handlung oder "so wie X", gib 8-12 passende, real existierende Titel zurück, die besten zuerst.
- "items" nur real existierende Titel. Keine Erfindungen.
- "channels" nur, wenn nach Live-TV/Sendern/Sport live gefragt wird (z. B. "ZDF", "Sky Sport Bundesliga"), sonst [].
- Bevorzuge Serien, wenn nicht eindeutig.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST erwartet" }, 405);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "ANTHROPIC_API_KEY fehlt im Supabase-Projekt (Edge Functions → Secrets)" }, 500);

  let q = "", context = "";
  try {
    const b = await req.json();
    q = String(b.q ?? "").trim().slice(0, 300);
    context = String(b.context ?? "").trim().slice(0, 1500);
  } catch { /* leer */ }
  if (!q) return json({ error: "Leere Anfrage" }, 400);

  const user = context ? `Anfrage: ${q}\n\nKontext (Watchlist/zuletzt gesehen): ${context}` : `Anfrage: ${q}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system: SYSTEM, messages: [{ role: "user", content: user }] }),
  });
  const t = await r.text();
  if (!r.ok) return json({ error: `Claude-API ${r.status}`, detail: t.slice(0, 300) }, 502);
  try {
    const text = (JSON.parse(t).content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    const out = JSON.parse(m ? m[0] : text);
    return json({
      answer: String(out.answer ?? ""),
      items: (Array.isArray(out.items) ? out.items : []).slice(0, 15).map((i: Record<string, unknown>) => ({
        title: String(i.title ?? ""), title_de: String(i.title_de ?? ""),
        year: typeof i.year === "number" ? i.year : null, type: i.type === "movie" ? "movie" : "tv",
      })).filter((i: { title: string }) => i.title),
      channels: (Array.isArray(out.channels) ? out.channels : []).map(String).slice(0, 5),
    });
  } catch {
    return json({ error: "Antwort nicht lesbar" }, 502);
  }
});
