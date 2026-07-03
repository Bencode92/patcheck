import {
  ABATTEMENTS, DON_FAMILIAL_SOMME, DELAI_RAPPEL_ANS,
  BAREMES_PAR_LIEN, LIBELLE_LIEN, calculDroits, tauxUsufruit,
  BAREME_LIGNE_DIRECTE, BAREME_USUFRUIT, AV_AVANT_70, AV_APRES_70,
} from "./data.js";

// ---------- Utilitaires ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10);
const eur = (n) =>
  (n ?? 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const pct = (n) => (n * 100).toFixed(0) + " %";
const parseNum = (v) => Number(String(v).replace(/[^\d.-]/g, "")) || 0;

function ageAu(naissance, dateRef = new Date()) {
  if (!naissance) return null;
  const n = new Date(naissance);
  let age = dateRef.getFullYear() - n.getFullYear();
  const m = dateRef.getMonth() - n.getMonth();
  if (m < 0 || (m === 0 && dateRef.getDate() < n.getDate())) age--;
  return age;
}
function anneesEcoulees(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return (now - d) / (365.25 * 24 * 3600 * 1000);
}

// ---------- État ----------
const KEY = "patrimoine_famille_v1";
const defaultState = () => ({
  personnes: [
    { id: uid(), nom: "Parent 1", role: "parent", naissance: "" },
    { id: uid(), nom: "Parent 2", role: "parent", naissance: "" },
    { id: uid(), nom: "Enfant 1", role: "enfant", naissance: "" },
    { id: uid(), nom: "Enfant 2", role: "enfant", naissance: "" },
    { id: uid(), nom: "Enfant 3", role: "enfant", naissance: "" },
  ],
  donations: [],
  av: [],
});
let state = load();
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : defaultState();
  } catch {
    return defaultState();
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}
const personne = (id) => state.personnes.find((p) => p.id === id);
const parents = () => state.personnes.filter((p) => p.role === "parent");
const enfants = () => state.personnes.filter((p) => p.role === "enfant");

// =============================================================
//  Calculs métier
// =============================================================

// Donations d'un donateur vers un bénéficiaire encore dans le
// délai de rappel fiscal (15 ans). Renvoie total consommé + détail.
function abattementConsomme(donateurId, beneficiaireId) {
  const actives = state.donations.filter(
    (d) =>
      d.donateurId === donateurId &&
      d.beneficiaireId === beneficiaireId &&
      anneesEcoulees(d.date) < DELAI_RAPPEL_ANS
  );
  const total = actives.reduce((s, d) => s + parseNum(d.montant), 0);
  return { total, donations: actives };
}

function abattementPlafond(lien) {
  return ABATTEMENTS[lien] ?? ABATTEMENTS.defaut;
}

// Simulation d'une transmission (donation ou succession)
// options: { montantPP, lien, ageUsufruitier, mode, donateurId, beneficiaireId }
// mode : 'pleine' | 'nue_propriete' | 'usufruit'
function simulerTransmission(o) {
  const lien = o.lien || "enfant";
  let baseTaxable = parseNum(o.montantPP);
  let tauxUS = null;
  if (o.mode === "nue_propriete" || o.mode === "usufruit") {
    tauxUS = tauxUsufruit(o.ageUsufruitier ?? 60);
    baseTaxable =
      o.mode === "nue_propriete"
        ? baseTaxable * (1 - tauxUS) // on transmet la NP
        : baseTaxable * tauxUS; // on transmet l'US
  }

  const plafond = abattementPlafond(lien);
  let dejaConsomme = 0;
  if (o.donateurId && o.beneficiaireId) {
    dejaConsomme = abattementConsomme(o.donateurId, o.beneficiaireId).total;
  }
  const abattementRestant = Math.max(0, plafond - dejaConsomme);
  const apresAbattement = Math.max(0, baseTaxable - abattementRestant);
  const bareme = BAREMES_PAR_LIEN[lien] || BAREMES_PAR_LIEN.defaut;
  const droits = calculDroits(apresAbattement, bareme);

  return {
    valeurPP: parseNum(o.montantPP),
    tauxUS,
    baseTaxable: Math.round(baseTaxable),
    plafondAbattement: plafond,
    dejaConsomme,
    abattementRestant,
    apresAbattement: Math.round(apresAbattement),
    droits,
    net: Math.round(baseTaxable - droits),
    tauxEffectif: baseTaxable > 0 ? droits / baseTaxable : 0,
  };
}

// Assurance-vie : primes avant 70 ans (990 I)
function simulerAvAvant70(montant) {
  const apres = Math.max(0, montant - AV_AVANT_70.abattement);
  const t1 = Math.min(apres, AV_AVANT_70.seuilTranche1);
  const t2 = Math.max(0, apres - AV_AVANT_70.seuilTranche1);
  const droits = Math.round(t1 * AV_AVANT_70.tauxTranche1 + t2 * AV_AVANT_70.tauxTranche2);
  return { abattement: AV_AVANT_70.abattement, apres, droits, net: montant - droits };
}

// =============================================================
//  Rendu — navigation par onglets
// =============================================================
const TABS = [
  { id: "famille", label: "👪 Famille" },
  { id: "donations", label: "🎁 Donations réalisées" },
  { id: "abattements", label: "📊 Abattements dispo." },
  { id: "simulateur", label: "🧮 Simulateur" },
  { id: "assurancevie", label: "🛡️ Assurance-vie" },
  { id: "baremes", label: "📚 Barèmes" },
];
let currentTab = "famille";

function render() {
  const app = $("#app");
  app.innerHTML = `
    <nav class="tabs">
      ${TABS.map(
        (t) =>
          `<button class="tab ${t.id === currentTab ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`
      ).join("")}
    </nav>
    <main id="tab-content"></main>`;
  $$(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      currentTab = b.dataset.tab;
      render();
    })
  );
  ({
    famille: renderFamille,
    donations: renderDonations,
    abattements: renderAbattements,
    simulateur: renderSimulateur,
    assurancevie: renderAv,
    baremes: renderBaremes,
  })[currentTab]();
}

// ---------- Onglet Famille ----------
function renderFamille() {
  const c = $("#tab-content");
  c.innerHTML = `
    <div class="card">
      <h2>Composition du foyer</h2>
      <p class="muted">Renseigne les personnes. La date de naissance sert au barème de démembrement (art. 669 CGI).</p>
      <table class="grid">
        <thead><tr><th>Nom</th><th>Rôle</th><th>Naissance</th><th>Âge</th><th></th></tr></thead>
        <tbody>
        ${state.personnes
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td><input class="nom" value="${p.nom}"></td>
            <td>
              <select class="role">
                <option value="parent" ${p.role === "parent" ? "selected" : ""}>Parent</option>
                <option value="enfant" ${p.role === "enfant" ? "selected" : ""}>Enfant</option>
                <option value="petit_enfant" ${p.role === "petit_enfant" ? "selected" : ""}>Petit-enfant</option>
              </select>
            </td>
            <td><input type="date" class="naissance" value="${p.naissance}"></td>
            <td class="age">${p.naissance ? ageAu(p.naissance) + " ans" : "—"}</td>
            <td><button class="del danger-link">✕</button></td>
          </tr>`
          )
          .join("")}
        </tbody>
      </table>
      <button id="addP" class="btn">+ Ajouter une personne</button>
    </div>`;

  $$("#tab-content tr[data-id]").forEach((tr) => {
    const id = tr.dataset.id;
    $(".nom", tr).addEventListener("input", (e) => {
      personne(id).nom = e.target.value;
      save();
    });
    $(".role", tr).addEventListener("change", (e) => {
      personne(id).role = e.target.value;
      save();
    });
    $(".naissance", tr).addEventListener("change", (e) => {
      personne(id).naissance = e.target.value;
      save();
      renderFamille();
    });
    $(".del", tr).addEventListener("click", () => {
      state.personnes = state.personnes.filter((p) => p.id !== id);
      save();
      renderFamille();
    });
  });
  $("#addP").addEventListener("click", () => {
    state.personnes.push({ id: uid(), nom: "Nouvelle personne", role: "enfant", naissance: "" });
    save();
    renderFamille();
  });
}

// ---------- Onglet Donations réalisées ----------
function renderDonations() {
  const c = $("#tab-content");
  const rows = [...state.donations].sort((a, b) => (a.date < b.date ? 1 : -1));
  c.innerHTML = `
    <div class="card">
      <h2>Historique des donations</h2>
      <p class="muted">Chaque donation consomme l'abattement du couple donateur → bénéficiaire pendant ${DELAI_RAPPEL_ANS} ans (rappel fiscal). Au-delà, l'abattement se recharge.</p>
      <table class="grid">
        <thead><tr>
          <th>Date</th><th>Donateur</th><th>Bénéficiaire</th><th>Nature</th>
          <th>Valeur taxable</th><th>Statut rappel</th><th></th>
        </tr></thead>
        <tbody>
        ${
          rows.length === 0
            ? `<tr><td colspan="7" class="muted center">Aucune donation enregistrée.</td></tr>`
            : rows
                .map((d) => {
                  const ecoul = anneesEcoulees(d.date);
                  const actif = ecoul < DELAI_RAPPEL_ANS;
                  const restant = Math.max(0, DELAI_RAPPEL_ANS - ecoul);
                  return `<tr data-id="${d.id}" class="${actif ? "" : "purged"}">
                    <td>${d.date || "—"}</td>
                    <td>${personne(d.donateurId)?.nom ?? "?"}</td>
                    <td>${personne(d.beneficiaireId)?.nom ?? "?"}</td>
                    <td>${natureLabel(d.nature)}</td>
                    <td>${eur(parseNum(d.montant))}</td>
                    <td>${
                      actif
                        ? `<span class="badge warn">rapportable — ${restant.toFixed(1)} an(s) restants</span>`
                        : `<span class="badge ok">purgée (&gt;${DELAI_RAPPEL_ANS} ans)</span>`
                    }</td>
                    <td><button class="del danger-link">✕</button></td>
                  </tr>`;
                })
                .join("")
        }
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>Ajouter une donation</h3>
      <div class="form-row">
        <label>Date<input type="date" id="d_date"></label>
        <label>Donateur${selectPersonnes("d_don", parents())}</label>
        <label>Bénéficiaire${selectPersonnes("d_ben", enfants())}</label>
      </div>
      <div class="form-row">
        <label>Nature
          <select id="d_nature">
            <option value="pleine">Pleine propriété</option>
            <option value="nue_propriete">Nue-propriété (démembrement)</option>
            <option value="somme_argent">Don de somme d'argent (790 G)</option>
          </select>
        </label>
        <label>Valeur taxable transmise (€)<input type="text" id="d_montant" placeholder="ex : 50000"></label>
        <label>Note<input type="text" id="d_note" placeholder="bien, réf. acte…"></label>
      </div>
      <button id="addDon" class="btn primary">Enregistrer la donation</button>
    </div>`;

  $$("#tab-content tr[data-id]").forEach((tr) =>
    $(".del", tr)?.addEventListener("click", () => {
      state.donations = state.donations.filter((d) => d.id !== tr.dataset.id);
      save();
      renderDonations();
    })
  );
  $("#addDon").addEventListener("click", () => {
    const don = {
      id: uid(),
      date: $("#d_date").value,
      donateurId: $("#d_don").value,
      beneficiaireId: $("#d_ben").value,
      nature: $("#d_nature").value,
      montant: parseNum($("#d_montant").value),
      note: $("#d_note").value,
      lien: "enfant",
    };
    if (!don.date || !don.montant) {
      alert("Renseigne au moins une date et un montant.");
      return;
    }
    state.donations.push(don);
    save();
    renderDonations();
  });
}
function natureLabel(n) {
  return { pleine: "Pleine propriété", nue_propriete: "Nue-propriété", somme_argent: "Somme d'argent (790 G)", usufruit: "Usufruit" }[n] || n;
}
function selectPersonnes(id, list, selected) {
  return `<select id="${id}">${list
    .map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${p.nom}</option>`)
    .join("")}</select>`;
}

// ---------- Onglet Abattements disponibles ----------
function renderAbattements() {
  const c = $("#tab-content");
  const cells = enfants()
    .map((enf) => {
      const parCol = parents()
        .map((par) => {
          const { total } = abattementConsomme(par.id, enf.id);
          const plafond = ABATTEMENTS.enfant;
          const restant = Math.max(0, plafond - total);
          const ratio = Math.min(1, total / plafond);
          return `<td>
            <div class="gauge"><div class="gauge-fill" style="width:${ratio * 100}%"></div></div>
            <div class="gauge-lbl"><b>${eur(restant)}</b> dispo.<br><span class="muted">${eur(total)} / ${eur(plafond)} consommé</span></div>
          </td>`;
        })
        .join("");
      return `<tr><th>${enf.nom}</th>${parCol}</tr>`;
    })
    .join("");

  const totalDispo = enfants().reduce((s, enf) => {
    return (
      s +
      parents().reduce((ss, par) => ss + Math.max(0, ABATTEMENTS.enfant - abattementConsomme(par.id, enf.id).total), 0)
    );
  }, 0);

  c.innerHTML = `
    <div class="card">
      <h2>Abattements encore disponibles</h2>
      <p class="muted">Abattement de ${eur(ABATTEMENTS.enfant)} par parent et par enfant, rechargé tous les ${DELAI_RAPPEL_ANS} ans. Ci-dessous ce qu'il reste à transmettre <b>en franchise de droits</b>.</p>
      <div class="kpi"><span>Capacité totale de donation exonérée immédiate</span><b>${eur(totalDispo)}</b></div>
      <table class="grid matrix">
        <thead><tr><th></th>${parents().map((p) => `<th>${p.nom}</th>`).join("")}</tr></thead>
        <tbody>${cells}</tbody>
      </table>
      <p class="muted small">💡 En plus, le <b>don familial de somme d'argent</b> (art. 790 G) ajoute ${eur(DON_FAMILIAL_SOMME)} par parent &lt; 80 ans vers chaque enfant majeur, également tous les ${DELAI_RAPPEL_ANS} ans.</p>
    </div>`;
}

// ---------- Onglet Simulateur ----------
function renderSimulateur() {
  const c = $("#tab-content");
  c.innerHTML = `
    <div class="card">
      <h2>Simulateur de transmission</h2>
      <div class="form-row">
        <label>Donateur${selectPersonnes("s_don", parents())}</label>
        <label>Bénéficiaire${selectPersonnes("s_ben", enfants())}</label>
        <label>Lien fiscal
          <select id="s_lien">
            ${Object.entries(LIBELLE_LIEN)
              .filter(([k]) => BAREMES_PAR_LIEN[k])
              .map(([k, v]) => `<option value="${k}" ${k === "enfant" ? "selected" : ""}>${v}</option>`)
              .join("")}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>Valeur en pleine propriété (€)<input type="text" id="s_montant" value="300000"></label>
        <label>Mode de transmission
          <select id="s_mode">
            <option value="pleine">Pleine propriété</option>
            <option value="nue_propriete">Nue-propriété (garder l'usufruit)</option>
            <option value="usufruit">Usufruit seul</option>
          </select>
        </label>
        <label>Âge de l'usufruitier<input type="number" id="s_age" value="65" min="0" max="110"></label>
      </div>
      <button id="s_go" class="btn primary">Calculer</button>
      <div id="s_result"></div>
    </div>`;

  // pré-remplir âge avec celui du donateur
  const syncAge = () => {
    const p = personne($("#s_don").value);
    if (p?.naissance) $("#s_age").value = ageAu(p.naissance);
  };
  $("#s_don").addEventListener("change", syncAge);
  syncAge();

  $("#s_go").addEventListener("click", () => {
    const r = simulerTransmission({
      montantPP: $("#s_montant").value,
      lien: $("#s_lien").value,
      mode: $("#s_mode").value,
      ageUsufruitier: Number($("#s_age").value),
      donateurId: $("#s_don").value,
      beneficiaireId: $("#s_ben").value,
    });
    $("#s_result").innerHTML = `
      <div class="result">
        <div class="line"><span>Valeur en pleine propriété</span><b>${eur(r.valeurPP)}</b></div>
        ${
          r.tauxUS !== null
            ? `<div class="line"><span>Barème 669 CGI (usufruit ${pct(r.tauxUS)} / NP ${pct(1 - r.tauxUS)})</span><b>base transmise ${eur(r.baseTaxable)}</b></div>`
            : ""
        }
        <div class="line"><span>Abattement du lien</span><b>${eur(r.plafondAbattement)}</b></div>
        <div class="line"><span>Déjà consommé (&lt;15 ans)</span><b>− ${eur(r.dejaConsomme)}</b></div>
        <div class="line"><span>Abattement restant applicable</span><b>${eur(r.abattementRestant)}</b></div>
        <div class="line"><span>Base taxable après abattement</span><b>${eur(r.apresAbattement)}</b></div>
        <div class="line total"><span>Droits de donation à payer</span><b>${eur(r.droits)}</b></div>
        <div class="line"><span>Taux effectif sur la part transmise</span><b>${pct(r.tauxEffectif)}</b></div>
      </div>
      <p class="muted small">Comparaison : en pleine propriété directe, transmettre ${eur(r.valeurPP)} coûterait ${eur(
        simulerTransmission({ montantPP: r.valeurPP, lien: $("#s_lien").value, mode: "pleine", donateurId: $("#s_don").value, beneficiaireId: $("#s_ben").value }).droits
      )} de droits. Le démembrement réduit l'assiette taxable à la seule nue-propriété.</p>`;
  });
}

// ---------- Onglet Assurance-vie ----------
function renderAv() {
  const c = $("#tab-content");
  c.innerHTML = `
    <div class="card">
      <h2>Assurance-vie — fiscalité au décès</h2>
      <div class="form-row">
        <label>Régime des primes
          <select id="av_regime">
            <option value="avant">Versées AVANT 70 ans (art. 990 I)</option>
            <option value="apres">Versées APRÈS 70 ans (art. 757 B)</option>
          </select>
        </label>
        <label>Capital / prime par bénéficiaire (€)<input type="text" id="av_montant" value="200000"></label>
      </div>
      <button id="av_go" class="btn primary">Calculer</button>
      <div id="av_result"></div>
      <p class="muted small">Avant 70 ans : abattement de ${eur(AV_AVANT_70.abattement)} <b>par bénéficiaire</b>, puis 20 % jusqu'à ${eur(
        AV_AVANT_70.seuilTranche1
      )} et 31,25 % au-delà. Après 70 ans : abattement global de ${eur(
        AV_APRES_70.abattementGlobal
      )} (tous bénéficiaires), les primes excédentaires réintègrent la succession — mais les gains restent exonérés.</p>
    </div>`;
  $("#av_go").addEventListener("click", () => {
    const m = parseNum($("#av_montant").value);
    const regime = $("#av_regime").value;
    let html;
    if (regime === "avant") {
      const r = simulerAvAvant70(m);
      html = `<div class="result">
        <div class="line"><span>Capital transmis</span><b>${eur(m)}</b></div>
        <div class="line"><span>Abattement (990 I)</span><b>− ${eur(r.abattement)}</b></div>
        <div class="line"><span>Base taxable</span><b>${eur(r.apres)}</b></div>
        <div class="line total"><span>Prélèvement</span><b>${eur(r.droits)}</b></div>
        <div class="line"><span>Net perçu</span><b>${eur(r.net)}</b></div>
      </div>`;
    } else {
      const apres = Math.max(0, m - AV_APRES_70.abattementGlobal);
      html = `<div class="result">
        <div class="line"><span>Primes versées après 70 ans</span><b>${eur(m)}</b></div>
        <div class="line"><span>Abattement global (757 B)</span><b>− ${eur(AV_APRES_70.abattementGlobal)}</b></div>
        <div class="line total"><span>Primes réintégrées à l'actif successoral</span><b>${eur(apres)}</b></div>
        <div class="line"><span class="muted">Ces primes seront taxées au barème de succession selon le lien (voir onglet Barèmes). Les intérêts/gains restent exonérés.</span></div>
      </div>`;
    }
    $("#av_result").innerHTML = html;
  });
}

// ---------- Onglet Barèmes ----------
function renderBaremes() {
  const c = $("#tab-content");
  const tranches = (b) =>
    b
      .map((t, i) => {
        const bas = i === 0 ? 0 : b[i - 1].plafond;
        return `<tr><td>${eur(bas)} – ${t.plafond === Infinity ? "∞" : eur(t.plafond)}</td><td>${pct(t.taux)}</td></tr>`;
      })
      .join("");
  c.innerHTML = `
    <div class="grid-2">
      <div class="card">
        <h3>Droits en ligne directe (parent → enfant)</h3>
        <table class="grid"><thead><tr><th>Part nette taxable</th><th>Taux</th></tr></thead><tbody>${tranches(
          BAREME_LIGNE_DIRECTE
        )}</tbody></table>
      </div>
      <div class="card">
        <h3>Abattements (renouvelables /15 ans)</h3>
        <table class="grid"><tbody>
          <tr><td>Enfant</td><td>${eur(ABATTEMENTS.enfant)}</td></tr>
          <tr><td>Petit-enfant</td><td>${eur(ABATTEMENTS.petit_enfant)}</td></tr>
          <tr><td>Époux / PACS (donation)</td><td>${eur(ABATTEMENTS.epoux_pacs)}</td></tr>
          <tr><td>Frère / sœur</td><td>${eur(ABATTEMENTS.frere_soeur)}</td></tr>
          <tr><td>Don familial somme (790 G)</td><td>${eur(DON_FAMILIAL_SOMME)}</td></tr>
          <tr><td>Personne handicapée (cumulable)</td><td>${eur(ABATTEMENTS.handicap)}</td></tr>
        </tbody></table>
      </div>
      <div class="card">
        <h3>Démembrement — art. 669 CGI</h3>
        <p class="muted small">Selon l'âge de l'usufruitier au jour de l'acte.</p>
        <table class="grid"><thead><tr><th>Âge usufruitier</th><th>Usufruit</th><th>Nue-propriété</th></tr></thead><tbody>
        ${BAREME_USUFRUIT.map((b, i) => {
          const bornBas = i === 0 ? 0 : BAREME_USUFRUIT[i - 1].ageMax + 1;
          const lbl = b.ageMax === 999 ? "91 ans et +" : `${bornBas} – ${b.ageMax} ans`;
          return `<tr><td>${lbl}</td><td>${pct(b.usufruit)}</td><td>${pct(1 - b.usufruit)}</td></tr>`;
        }).join("")}
        </tbody></table>
      </div>
      <div class="card">
        <h3>Assurance-vie</h3>
        <table class="grid"><tbody>
          <tr><td>Abattement / bénéf. (avant 70 ans, 990 I)</td><td>${eur(AV_AVANT_70.abattement)}</td></tr>
          <tr><td>Taux jusqu'à ${eur(AV_AVANT_70.seuilTranche1)}</td><td>${pct(AV_AVANT_70.tauxTranche1)}</td></tr>
          <tr><td>Taux au-delà</td><td>${pct(AV_AVANT_70.tauxTranche2)}</td></tr>
          <tr><td>Abattement global (après 70 ans, 757 B)</td><td>${eur(AV_APRES_70.abattementGlobal)}</td></tr>
        </tbody></table>
      </div>
    </div>
    <p class="muted small center">⚠️ Barèmes indicatifs 2026 — à vérifier avec ton notaire / la loi de finances en vigueur.</p>`;
}

// ---------- Boot + gestion données ----------
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "patrimoine-famille.json";
  a.click();
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = JSON.parse(reader.result);
      save();
      render();
    } catch {
      alert("Fichier invalide.");
    }
  };
  reader.readAsText(file);
}

document.addEventListener("DOMContentLoaded", () => {
  render();
  $("#export")?.addEventListener("click", exportData);
  $("#import")?.addEventListener("change", (e) => e.target.files[0] && importData(e.target.files[0]));
  $("#reset")?.addEventListener("click", () => {
    if (confirm("Réinitialiser toutes les données ?")) {
      state = defaultState();
      save();
      render();
    }
  });
});
