// =============================================================
//  Synchronisation cloud (Cloudflare Pages Functions + KV)
//  Fonctionne quand l'app est servie depuis le déploiement
//  Cloudflare (l'endpoint /api/data existe). Sinon, dégrade
//  proprement (l'app reste utilisable en localStorage seul).
// =============================================================

const PWD_KEY = "patcheck_cloud_pwd";
const AUTO_KEY = "patcheck_cloud_auto";
const API = "/api/data";

export const getPassword = () => localStorage.getItem(PWD_KEY) || "";
export const setPassword = (p) => localStorage.setItem(PWD_KEY, p || "");
export const isAuto = () => localStorage.getItem(AUTO_KEY) === "1";
export const setAuto = (v) => localStorage.setItem(AUTO_KEY, v ? "1" : "0");

// L'endpoint /api/data existe-t-il ? (présent uniquement sur Cloudflare)
export async function cloudAvailable() {
  try {
    const r = await fetch(API, { method: "HEAD" });
    return r.ok || r.status === 401; // 204 (ok) ou 401 => l'API répond
  } catch {
    return false;
  }
}

export async function cloudLoad(password = getPassword()) {
  const r = await fetch(API, { headers: { "x-app-password": password } });
  if (r.status === 401) throw new Error("Mot de passe incorrect");
  if (!r.ok) throw new Error("Erreur cloud (" + r.status + ")");
  return await r.json(); // état sauvegardé, ou null
}

export async function cloudSave(state, password = getPassword()) {
  const r = await fetch(API, {
    method: "PUT",
    headers: { "x-app-password": password, "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  if (r.status === 401) throw new Error("Mot de passe incorrect");
  if (!r.ok) throw new Error("Erreur cloud (" + r.status + ")");
  return await r.json();
}

// Sauvegarde auto anti-rebond (appelée à chaque modification)
let timer = null;
export function scheduleAutoSave(getState, onStatus) {
  if (!isAuto() || !getPassword()) return;
  clearTimeout(timer);
  onStatus?.("pending");
  timer = setTimeout(async () => {
    try {
      const res = await cloudSave(getState());
      onStatus?.("saved", res.savedAt);
    } catch (e) {
      onStatus?.("error", e.message);
    }
  }, 1500);
}
