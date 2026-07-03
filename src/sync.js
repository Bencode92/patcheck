// =============================================================
//  Synchronisation cloud
//  Deux modes possibles :
//   - Cloudflare Pages (Functions) : API relative "/api/data"
//   - Cloudflare Worker dédié : URL absolue collée par l'utilisateur
//  L'URL de l'API est configurable et mémorisée dans le navigateur.
// =============================================================

const PWD_KEY = "patcheck_cloud_pwd";
const AUTO_KEY = "patcheck_cloud_auto";
const URL_KEY = "patcheck_api_url";

export const getPassword = () => localStorage.getItem(PWD_KEY) || "";
export const setPassword = (p) => localStorage.setItem(PWD_KEY, p || "");
export const isAuto = () => localStorage.getItem(AUTO_KEY) === "1";
export const setAuto = (v) => localStorage.setItem(AUTO_KEY, v ? "1" : "0");
export const getApiUrl = () => localStorage.getItem(URL_KEY) || "/api/data";
export const setApiUrl = (u) => localStorage.setItem(URL_KEY, (u || "").trim());

// L'API répond-elle ? (HEAD non authentifié)
export async function cloudAvailable() {
  try {
    const r = await fetch(getApiUrl(), { method: "HEAD" });
    return r.ok || r.status === 401 || r.status === 204;
  } catch {
    return false;
  }
}

export async function cloudLoad(password = getPassword()) {
  const r = await fetch(getApiUrl(), { headers: { "x-app-password": password } });
  if (r.status === 401) throw new Error("Mot de passe incorrect");
  if (!r.ok) throw new Error("Erreur cloud (" + r.status + ")");
  return await r.json(); // état sauvegardé, ou null
}

export async function cloudSave(state, password = getPassword()) {
  const r = await fetch(getApiUrl(), {
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
