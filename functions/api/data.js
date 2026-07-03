// =============================================================
//  Cloudflare Pages Function — stockage privé des données
//  Route : /api/data   (GET = charger, PUT = sauvegarder)
//
//  Nécessite, côté projet Cloudflare Pages :
//   - un binding KV nommé  PATCHECK_KV
//   - une variable/secret   APP_PASSWORD  (le mot de passe d'accès)
// =============================================================

const KEY = "patcheck-data";
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function authorized(request, env) {
  const given = request.headers.get("x-app-password") || "";
  // Comparaison simple ; APP_PASSWORD doit être défini côté Cloudflare.
  return Boolean(env.APP_PASSWORD) && given === env.APP_PASSWORD;
}

// GET /api/data -> renvoie l'état sauvegardé (ou null s'il n'y en a pas)
export async function onRequestGet({ request, env }) {
  if (!env.PATCHECK_KV) return json({ error: "KV non configuré (binding PATCHECK_KV manquant)" }, 500);
  if (!authorized(request, env)) return json({ error: "Mot de passe invalide" }, 401);
  const data = await env.PATCHECK_KV.get(KEY);
  return new Response(data || "null", { headers: { "content-type": "application/json; charset=utf-8" } });
}

// PUT /api/data -> enregistre l'état (corps = JSON)
export async function onRequestPut({ request, env }) {
  if (!env.PATCHECK_KV) return json({ error: "KV non configuré (binding PATCHECK_KV manquant)" }, 500);
  if (!authorized(request, env)) return json({ error: "Mot de passe invalide" }, 401);
  const body = await request.text();
  if (body.length > 3_000_000) return json({ error: "Données trop volumineuses" }, 413);
  try {
    JSON.parse(body); // valide que c'est bien du JSON
  } catch {
    return json({ error: "Corps non JSON" }, 400);
  }
  await env.PATCHECK_KV.put(KEY, body);
  return json({ ok: true, savedAt: new Date().toISOString() });
}

// Petit ping non authentifié pour savoir si l'API existe (détection côté app)
export async function onRequestHead() {
  return new Response(null, { status: 204 });
}
