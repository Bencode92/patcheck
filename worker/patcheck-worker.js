// =============================================================
//  Worker Cloudflare — stockage privé des données patcheck
//  À coller dans un Worker Cloudflare (dash.cloudflare.com).
//
//  Configuration requise sur le Worker :
//   - Binding KV nommé  PATCHECK_KV
//   - Secret            APP_PASSWORD  (mot de passe d'accès)
//
//  L'app (onglet Données → Sauvegarde en ligne) appelle l'URL
//  de ce Worker (…​.workers.dev) avec l'en-tête x-app-password.
// =============================================================

const KEY = "patcheck-data";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-app-password",
  "Access-Control-Max-Age": "86400",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "HEAD") return new Response(null, { status: 204, headers: cors });

    if (!env.PATCHECK_KV) return json({ error: "KV manquant (binding PATCHECK_KV)" }, 500);
    const ok = Boolean(env.APP_PASSWORD) && (request.headers.get("x-app-password") || "") === env.APP_PASSWORD;

    if (request.method === "GET") {
      if (!ok) return json({ error: "Mot de passe invalide" }, 401);
      const data = await env.PATCHECK_KV.get(KEY);
      return new Response(data || "null", {
        headers: { "content-type": "application/json; charset=utf-8", ...cors },
      });
    }

    if (request.method === "PUT") {
      if (!ok) return json({ error: "Mot de passe invalide" }, 401);
      const body = await request.text();
      if (body.length > 3_000_000) return json({ error: "Trop volumineux" }, 413);
      try { JSON.parse(body); } catch { return json({ error: "Corps non JSON" }, 400); }
      await env.PATCHECK_KV.put(KEY, body);
      return json({ ok: true, savedAt: new Date().toISOString() });
    }

    return json({ error: "Méthode non supportée" }, 405);
  },
};
