// =============================================================
//  Worker Cloudflare — stockage privé des données patcheck
//  À coller dans un Worker Cloudflare (dash.cloudflare.com).
//
//  Configuration requise sur le Worker :
//   - Binding KV nommé  PATCHECK_KV
//   - Secret            APP_PASSWORD      (mot de passe d'accès)
//   - Secret            ANTHROPIC_API_KEY (facultatif — active l'IA Conseil)
//
//  L'app (onglet Données → Sauvegarde en ligne) appelle l'URL
//  de ce Worker (…​.workers.dev) avec l'en-tête x-app-password.
// =============================================================

const KEY = "patcheck-data";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, HEAD, OPTIONS",
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

    // POST = requête IA Conseil (proxy vers Claude, clé API côté serveur)
    if (request.method === "POST") {
      if (!ok) return json({ error: "Mot de passe invalide" }, 401);
      if (!env.ANTHROPIC_API_KEY) return json({ error: "IA non configurée : ajoute le secret ANTHROPIC_API_KEY sur le Worker." }, 501);
      let payload;
      try { payload = await request.json(); } catch { return json({ error: "Corps non JSON" }, 400); }
      const messages = Array.isArray(payload.messages) ? payload.messages.slice(-20) : [];
      if (!messages.length) return json({ error: "Aucun message" }, 400);
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          max_tokens: 3000,
          system: String(payload.system || "").slice(0, 40000),
          messages,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return json({ error: (data && data.error && data.error.message) || "Erreur API Claude" }, 502);
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return json({ text });
    }

    return json({ error: "Méthode non supportée" }, 405);
  },
};
