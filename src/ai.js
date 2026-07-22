// =============================================================
//  Appel IA (Claude Opus 4.8) via le Worker Cloudflare.
//  Le Worker garde la clé API en secret (ANTHROPIC_API_KEY) et
//  répond sur la même URL que la sauvegarde, en POST.
// =============================================================
import { getPassword, getApiUrl } from "./sync.js?v=82";

// Envoie une conversation à l'IA. `system` = consigne + contexte patrimonial,
// `messages` = [{role:'user'|'assistant', content}]. Renvoie le texte de réponse.
export async function askAI(system, messages) {
  const url = getApiUrl();
  if (!url || url === "/api/data") throw new Error("IA indisponible : configure d'abord ton Worker Cloudflare (onglet Données).");
  const r = await fetch(url, {
    method: "POST",
    headers: { "x-app-password": getPassword(), "content-type": "application/json" },
    body: JSON.stringify({ system, messages }),
  });
  if (r.status === 401) throw new Error("Mot de passe incorrect");
  if (!r.ok) {
    let msg = "Erreur " + r.status;
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const d = await r.json();
  return (d.text || "").trim();
}
