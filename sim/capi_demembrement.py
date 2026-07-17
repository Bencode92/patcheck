"""
Simulateur fiscal — Contrat de capitalisation : démembrement vs pleine propriété vs succession
==============================================================================================

Compare, sur un horizon paramétrable, le coût fiscal TOTAL (droits de mutation
+ IR + prélèvements sociaux au rachat) de trois stratégies de transmission d'un
contrat de capitalisation français, puis le NET final revenant à l'enfant.

    A) Donation de la NUE-PROPRIÉTÉ (démembrement) — le parent garde l'usufruit ;
       l'enfant rachète après le décès du parent.
    B) Donation en PLEINE PROPRIÉTÉ — l'enfant rachète.
    C) Aucune donation — SUCCESSION classique au décès, puis rachat par l'enfant.

--------------------------------------------------------------------------------
HYPOTHÈSES ET RÈGLES FISCALES RETENUES (France, état du droit ~ juillet 2026)
--------------------------------------------------------------------------------
1. DONATION démembrée (A) : taxée aux droits de mutation à titre gratuit (DMTG)
   sur  V_don × fraction_NP(âge du donateur)  (barème art. 669 CGI), après
   abattement 100 000 €/parent/enfant/15 ans. Barème ligne directe (art. 777).
2. DÉCÈS du parent : extinction de l'usufruit SANS droits (art. 1133 CGI).
   AUCUN step-up de la base IR.
3. RACHAT par l'enfant après décès (A) :
       gain imposable = V_rachat − V_NP_au_jour_de_la_donation
   (BOI-RPPM-RCM-20-10-20-50 §225, lecture prudente/majoritaire).
   => PURGE SEULEMENT PARTIELLE : la fraction usufruit et toute la plus-value
   post-donation restent imposables à l'IR + PS.
   ⚠️ INCERTITUDE : base non tranchée — QE Sénat n°07190 (Daubresse, 01/01/2026)
   sans réponse. Le scénario d'incertitude recalcule avec base = V_PP_donation
   et base = V_décès pour BORNER le risque.
4. DONATION pleine propriété (B) : DMTG sur V_don entière ; au rachat, purge
   TOTALE => gain = V_rachat − V_don.
5. SUCCESSION (C) : le contrat entre dans l'actif successoral, taxé au barème
   ligne directe sur V_décès (après abattement 100 000 €). Acquisition à titre
   gratuit => base IR au rachat = valeur vénale retenue pour les DMTG = V_décès
   (STEP-UP au décès, §225). gain = V_rachat − V_décès.
6. Antériorité fiscale (8 ans) conservée dans tous les cas (date de souscription
   d'origine). Après 8 ans : abattement annuel 4 600 € (seul) / 9 200 € (couple)
   sur les GAINS ; taux 7,5 % (primes ≤ 150 000 €, ou versées avant 27/09/2017)
   sinon 12,8 %. Avant 8 ans : PFU 12,8 % (option barème possible).
   Prélèvements sociaux 17,2 % sur le gain, dans tous les cas.
7. RACHATS ANNUELS OPTIMISÉS par l'usufruitier (option) : chaque année (contrat
   > 8 ans), il retire la fraction de gain absorbée par l'abattement annuel
   (IR nul, PS 17,2 %), ce qui réduit la PV « piégée » transmise à l'enfant.
   Le cash net extrait est suivi séparément (reste dans le patrimoine du parent).

SIMPLIFICATIONS : arbitrages internes du contrat neutres ; un seul couple
donateur→enfant (adaptable) ; rendement r constant ; pas de rappel des 15 ans
modélisé (à activer via l'abattement disponible) ; TMI constante.

⚠️ DISCLAIMER : ceci n'est PAS un conseil fiscal. Modèle pédagogique reposant
sur une doctrine dont l'application au démembrement n'est pas confirmée et peut
évoluer (réponse ministérielle attendue). Toute décision (donation, rachat)
doit être validée par un notaire / avocat fiscaliste.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field

# --------------------------------------------------------------------------- #
#  Barèmes et constantes
# --------------------------------------------------------------------------- #

# Droits de mutation à titre gratuit — ligne directe (parent -> enfant), art. 777.
# (plafond de tranche sur la part nette taxable APRÈS abattement, taux marginal)
BAREME_LIGNE_DIRECTE = [
    (8072, 0.05),
    (12109, 0.10),
    (15932, 0.15),
    (552324, 0.20),
    (902838, 0.30),
    (1805677, 0.40),
    (float("inf"), 0.45),
]

ABATTEMENT_ENFANT = 100_000.0      # par parent / enfant / 15 ans (art. 779 I)
PS_RATE = 0.172                    # prélèvements sociaux
ABATT_ANNUEL_SEUL = 4_600.0        # abattement annuel gains, contrat > 8 ans
ABATT_ANNUEL_COUPLE = 9_200.0
SEUIL_PRIMES_REDUIT = 150_000.0    # seuil primes pour le taux réduit 7,5 %
TAUX_REDUIT = 0.075                # IR primes <= 150k (ou avant 27/09/2017), > 8 ans
TAUX_PFU = 0.128                   # PFU IR


def fraction_np(age: int) -> float:
    """Fraction de la NUE-PROPRIÉTÉ selon l'âge de l'usufruitier (art. 669 CGI).
    NP = 100 % − usufruit ; croît avec l'âge du donateur."""
    if age <= 20:
        return 0.10
    if age <= 30:
        return 0.20
    if age <= 40:
        return 0.30
    if age <= 50:
        return 0.40
    if age <= 60:
        return 0.50
    if age <= 70:
        return 0.60
    if age <= 80:
        return 0.70
    if age <= 90:
        return 0.80
    return 0.90


def droits_dmtg(base_taxable: float, abattement: float = ABATTEMENT_ENFANT) -> float:
    """Droits ligne directe sur une base, après application de l'abattement."""
    net = max(0.0, base_taxable - abattement)
    droits, bas = 0.0, 0.0
    for plafond, taux in BAREME_LIGNE_DIRECTE:
        if net > bas:
            haut = min(net, plafond)
            droits += (haut - bas) * taux
            bas = plafond
        else:
            break
    return round(droits, 2)


def impot_rachat(
    gain: float,
    contrat_age_ans: float,
    primes_totales: float,
    primes_avant_2017: bool,
    use_bareme: bool,
    tmi: float,
    couple: bool,
    abattement_annuel_utilise: bool = True,
) -> tuple[float, float]:
    """Retourne (IR, PS) sur le gain d'un rachat de contrat de capitalisation.

    - PS 17,2 % sur le gain intégral.
    - IR : abattement annuel 4 600/9 200 € si contrat > 8 ans, puis 7,5 % (primes
      <= 150k ou avant 27/09/2017) ou 12,8 %. Avant 8 ans : PFU 12,8 %.
      Option barème : IR = TMI × gain (après abattement le cas échéant).
    """
    if gain <= 0:
        return 0.0, 0.0
    ps = gain * PS_RATE
    abatt = 0.0
    if contrat_age_ans >= 8 and abattement_annuel_utilise:
        abatt = ABATT_ANNUEL_COUPLE if couple else ABATT_ANNUEL_SEUL
    gain_ir = max(0.0, gain - abatt)

    if use_bareme:
        ir = gain_ir * tmi
    elif contrat_age_ans >= 8:
        if primes_avant_2017 or primes_totales <= SEUIL_PRIMES_REDUIT:
            taux = TAUX_REDUIT
        else:  # part des primes <= 150k au taux réduit, le reste au PFU
            frac_reduit = SEUIL_PRIMES_REDUIT / primes_totales
            taux = TAUX_REDUIT * frac_reduit + TAUX_PFU * (1 - frac_reduit)
        ir = gain_ir * taux
    else:
        ir = gain_ir * TAUX_PFU
    return round(ir, 2), round(ps, 2)


# --------------------------------------------------------------------------- #
#  Paramètres
# --------------------------------------------------------------------------- #

@dataclass
class Params:
    primes: float = 300_000.0          # P versées à la souscription
    age_donateur: int = 62             # âge du donateur au jour de la donation
    rendement: float = 0.03            # r annuel
    annees_don_deces: float = 20.0     # donation -> décès
    annees_deces_rachat: float = 3.0   # décès -> rachat par l'enfant
    annees_sous_don: float = 0.0       # souscription -> donation (souvent ~0)
    tmi: float = 0.30                  # tranche marginale d'imposition
    couple: bool = True
    primes_avant_2017: bool = False
    use_bareme: bool = False           # IR au barème plutôt qu'au PFU
    abattement_donation: float = ABATTEMENT_ENFANT
    rachats_annuels_optimises: bool = False  # usufruitier purge sous abattement

    # valeurs dérivées
    @property
    def v_don(self) -> float:
        return self.primes * (1 + self.rendement) ** self.annees_sous_don

    @property
    def v_deces(self) -> float:
        return self.v_don * (1 + self.rendement) ** self.annees_don_deces

    @property
    def v_rachat(self) -> float:
        return self.v_deces * (1 + self.rendement) ** self.annees_deces_rachat

    @property
    def age_contrat_rachat(self) -> float:
        return self.annees_sous_don + self.annees_don_deces + self.annees_deces_rachat


# --------------------------------------------------------------------------- #
#  Rachats annuels optimisés par l'usufruitier (stratégie A option)
# --------------------------------------------------------------------------- #

def simule_purge_usufruitier(p: Params) -> tuple[float, float, float]:
    """Simule l'accumulation donation->décès avec rachats annuels de l'usufruitier
    plafonnés à l'abattement (contrat > 8 ans). Retourne :
      (valeur au décès, base_primes résiduelle, cash NET extrait par l'usufruitier).
    Base réduite proportionnellement aux rachats (méthode fiscale du prorata).
    """
    v = p.v_don
    base = p.primes  # base de calcul du gain (primes)
    abatt = ABATT_ANNUEL_COUPLE if p.couple else ABATT_ANNUEL_SEUL
    cash_net = 0.0
    age_contrat = p.annees_sous_don
    for _ in range(int(round(p.annees_don_deces))):
        v_avant = v
        v *= (1 + p.rendement)
        age_contrat += 1
        # L'usufruitier ne prélève que les PRODUITS de l'année (les fruits),
        # dans la limite de l'abattement annuel → gain retiré non imposé à l'IR.
        if p.rachats_annuels_optimises and age_contrat >= 8 and v > base:
            gain_annuel = v - v_avant
            gain_retire = min(gain_annuel, abatt)          # part de gain non taxée
            part_gain = (v - base) / v
            retrait = min(v, gain_retire / part_gain) if part_gain > 0 else 0.0
            cash_net += retrait - gain_retire * PS_RATE    # IR nul (abattement), PS 17,2 %
            base -= retrait * (base / v)                   # base au prorata
            v -= retrait
    return v, base, cash_net


# --------------------------------------------------------------------------- #
#  Stratégies
# --------------------------------------------------------------------------- #

def _resultat(nom, droits, ir, ps, v_rachat, cash_usufruitier=0.0, base_ir=None, note=""):
    total_prelevements = droits + ir + ps
    net_enfant = v_rachat - ir - ps - droits
    return {
        "strategie": nom,
        "droits_mutation": round(droits, 2),
        "ir_rachat": round(ir, 2),
        "ps_rachat": round(ps, 2),
        "total_prelevements": round(total_prelevements, 2),
        "cash_usufruitier_net": round(cash_usufruitier, 2),
        "net_enfant": round(net_enfant, 2),
        "net_famille": round(net_enfant + cash_usufruitier, 2),
        "base_ir_rachat": None if base_ir is None else round(base_ir, 2),
        "note": note,
    }


def strategie_A(p: Params, base_ir_override: str | None = None) -> dict:
    """Donation NP puis rachat enfant au décès. base_ir_override: None (=NP §225),
    'pp_don' (=V_don), 'deces' (=V_décès) pour le scénario d'incertitude."""
    v_np_don = p.v_don * fraction_np(p.age_donateur)
    droits = droits_dmtg(v_np_don, p.abattement_donation)

    if p.rachats_annuels_optimises:
        v_deces, base_primes, cash = simule_purge_usufruitier(p)
        v_rachat = v_deces * (1 + p.rendement) ** p.annees_deces_rachat
    else:
        v_deces, cash = p.v_deces, 0.0
        v_rachat = p.v_rachat

    if base_ir_override == "pp_don":
        base_ir, note = p.v_don, "incertitude §225 : base = valeur PP au jour de la donation"
    elif base_ir_override == "deces":
        base_ir, note = v_deces, "incertitude §225 : base = valeur au décès (step-up)"
    else:
        base_ir, note = v_np_don, "base = valeur NP à la donation (lecture prudente §225)"

    gain = max(0.0, v_rachat - base_ir)
    ir, ps = impot_rachat(gain, p.age_contrat_rachat, p.primes, p.primes_avant_2017,
                          p.use_bareme, p.tmi, p.couple)
    return _resultat("A · Donation NP (démembrement)", droits, ir, ps, v_rachat,
                     cash_usufruitier=cash, base_ir=base_ir, note=note)


def strategie_B(p: Params) -> dict:
    """Donation pleine propriété puis rachat enfant (purge totale à V_don)."""
    droits = droits_dmtg(p.v_don, p.abattement_donation)
    gain = max(0.0, p.v_rachat - p.v_don)  # purge totale
    ir, ps = impot_rachat(gain, p.age_contrat_rachat, p.primes, p.primes_avant_2017,
                          p.use_bareme, p.tmi, p.couple)
    return _resultat("B · Donation pleine propriété", droits, ir, ps, p.v_rachat,
                     base_ir=p.v_don, note="purge totale à la valeur du jour de la donation")


def strategie_C(p: Params) -> dict:
    """Pas de donation : succession au décès (step-up base IR = V_décès, §225)."""
    droits = droits_dmtg(p.v_deces, p.abattement_donation)
    gain = max(0.0, p.v_rachat - p.v_deces)  # step-up succession
    ir, ps = impot_rachat(gain, p.age_contrat_rachat, p.primes, p.primes_avant_2017,
                          p.use_bareme, p.tmi, p.couple)
    return _resultat("C · Succession (aucune donation)", droits, ir, ps, p.v_rachat,
                     base_ir=p.v_deces, note="step-up : base IR = valeur au décès (§225)")


# --------------------------------------------------------------------------- #
#  Comparaison + incertitude + sensibilité
# --------------------------------------------------------------------------- #

def comparer(p: Params) -> list[dict]:
    return [strategie_A(p), strategie_B(p), strategie_C(p)]


def scenario_incertitude(p: Params) -> list[dict]:
    """Borne le risque §225 pour la stratégie A : NP (prudent) / PP-don / décès."""
    return [
        strategie_A(p, base_ir_override=None),
        strategie_A(p, base_ir_override="pp_don"),
        strategie_A(p, base_ir_override="deces"),
    ]


def sensibilite(p: Params, variable: str, valeurs: list) -> dict:
    """Renvoie, pour chaque valeur d'un paramètre, le net_enfant des 3 stratégies."""
    out = {"variable": variable, "valeurs": valeurs, "A": [], "B": [], "C": []}
    for v in valeurs:
        pp = Params(**{**p.__dict__, variable: v})
        out["A"].append(strategie_A(pp)["net_enfant"])
        out["B"].append(strategie_B(pp)["net_enfant"])
        out["C"].append(strategie_C(pp)["net_enfant"])
    return out


# --------------------------------------------------------------------------- #
#  Affichage
# --------------------------------------------------------------------------- #

def _eur(x) -> str:
    return f"{x:,.0f} €".replace(",", " ")


def tableau_recap(p: Params) -> str:
    rows = comparer(p)
    best = max(rows, key=lambda r: r["net_enfant"])
    lignes = []
    lignes.append("=" * 96)
    lignes.append("CONTRAT DE CAPITALISATION — COMPARAISON DES STRATÉGIES DE TRANSMISSION")
    lignes.append("=" * 96)
    lignes.append(
        f"Primes {_eur(p.primes)} · donateur {p.age_donateur} ans · r {p.rendement:.1%} · "
        f"donation→décès {p.annees_don_deces:.0f} ans · décès→rachat {p.annees_deces_rachat:.0f} ans"
    )
    lignes.append(
        f"Valeurs : donation {_eur(p.v_don)} · NP {_eur(p.v_don*fraction_np(p.age_donateur))} "
        f"(NP {fraction_np(p.age_donateur):.0%}) · décès {_eur(p.v_deces)} · rachat {_eur(p.v_rachat)}"
    )
    lignes.append("-" * 96)
    entete = f"{'Stratégie':<32}{'Droits mut.':>13}{'IR rachat':>12}{'PS rachat':>12}{'Total prélèv.':>15}{'NET enfant':>14}"
    lignes.append(entete)
    lignes.append("-" * 96)
    for r in rows:
        star = "  ⭐" if r is best else ""
        lignes.append(
            f"{r['strategie']:<32}{_eur(r['droits_mutation']):>13}{_eur(r['ir_rachat']):>12}"
            f"{_eur(r['ps_rachat']):>12}{_eur(r['total_prelevements']):>15}{_eur(r['net_enfant']):>14}{star}"
        )
        if r["cash_usufruitier_net"] > 0:
            lignes.append(f"{'   + cash usufruitier (rachats vie)':<32}{'':<52}{_eur(r['cash_usufruitier_net']):>14}")
    lignes.append("-" * 96)
    lignes.append(f"➜ Le plus avantageux pour l'enfant : {best['strategie']}  (net {_eur(best['net_enfant'])})")
    lignes.append("")
    lignes.append("SCÉNARIO D'INCERTITUDE §225 (stratégie A — quelle base IR au rachat ?)")
    lignes.append("-" * 96)
    for r in scenario_incertitude(p):
        lignes.append(f"  {r['note']:<62}{'net enfant':>0} {_eur(r['net_enfant']):>14}")
    lignes.append("=" * 96)
    lignes.append("⚠️  Estimation pédagogique — PAS un conseil fiscal. À valider notaire/fiscaliste.")
    lignes.append("    Base IR du démembrement non tranchée : QE Sénat n°07190 (Daubresse) sans réponse.")
    return "\n".join(lignes)


def graphiques(p: Params, chemin: str = "capi_comparaison.png") -> str | None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception as e:  # noqa: BLE001
        print(f"[matplotlib indisponible : {e}] — graphiques ignorés.")
        return None

    rows = comparer(p)
    noms = ["A · NP", "B · PP", "C · Succ."]
    fig, axes = plt.subplots(2, 2, figsize=(13, 9))
    fig.suptitle("Contrat de capitalisation — démembrement vs pleine propriété vs succession", fontsize=13, fontweight="bold")

    # (1) décomposition des prélèvements empilés
    ax = axes[0, 0]
    droits = [r["droits_mutation"] for r in rows]
    ir = [r["ir_rachat"] for r in rows]
    ps = [r["ps_rachat"] for r in rows]
    ax.bar(noms, droits, label="Droits mutation", color="#c026a3")
    ax.bar(noms, ir, bottom=droits, label="IR rachat", color="#1e63d6")
    ax.bar(noms, ps, bottom=[d + i for d, i in zip(droits, ir)], label="PS rachat", color="#0a9d6e")
    ax.set_title("Prélèvements totaux (décomposition)")
    ax.set_ylabel("€")
    ax.legend(fontsize=8)

    # (2) net final enfant
    ax = axes[0, 1]
    nets = [r["net_enfant"] for r in rows]
    couleurs = ["#0a9d6e" if n == max(nets) else "#8aa0b8" for n in nets]
    ax.bar(noms, nets, color=couleurs)
    ax.set_title("NET final revenant à l'enfant")
    ax.set_ylabel("€")
    for i, n in enumerate(nets):
        ax.text(i, n, _eur(n), ha="center", va="bottom", fontsize=8)

    # (3) sensibilité au rendement r
    ax = axes[1, 0]
    rs = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]
    s = sensibilite(p, "rendement", rs)
    ax.plot([f"{x:.0%}" for x in rs], s["A"], "-o", label="A · NP", color="#c026a3")
    ax.plot([f"{x:.0%}" for x in rs], s["B"], "-s", label="B · PP", color="#1e63d6")
    ax.plot([f"{x:.0%}" for x in rs], s["C"], "-^", label="C · Succ.", color="#0a9d6e")
    ax.set_title("Sensibilité au rendement annuel")
    ax.set_xlabel("r"); ax.set_ylabel("net enfant €"); ax.legend(fontsize=8)

    # (4) sensibilité à l'âge du donateur
    ax = axes[1, 1]
    ages = [52, 57, 62, 67, 72, 77]
    s = sensibilite(p, "age_donateur", ages)
    ax.plot(ages, s["A"], "-o", label="A · NP", color="#c026a3")
    ax.plot(ages, s["B"], "-s", label="B · PP", color="#1e63d6")
    ax.plot(ages, s["C"], "-^", label="C · Succ.", color="#0a9d6e")
    ax.set_title("Sensibilité à l'âge du donateur")
    ax.set_xlabel("âge donation"); ax.set_ylabel("net enfant €"); ax.legend(fontsize=8)

    fig.tight_layout(rect=[0, 0, 1, 0.96])
    fig.savefig(chemin, dpi=110)
    plt.close(fig)
    return chemin


# --------------------------------------------------------------------------- #
#  CLI
# --------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser(description="Simulateur contrat de capitalisation démembré")
    ap.add_argument("--primes", type=float, default=300_000)
    ap.add_argument("--age", type=int, default=62, dest="age_donateur")
    ap.add_argument("--r", type=float, default=0.03, dest="rendement")
    ap.add_argument("--don-deces", type=float, default=20, dest="annees_don_deces")
    ap.add_argument("--deces-rachat", type=float, default=3, dest="annees_deces_rachat")
    ap.add_argument("--tmi", type=float, default=0.30)
    ap.add_argument("--seul", action="store_true", help="donateur seul (sinon couple)")
    ap.add_argument("--barème", "--bareme", action="store_true", dest="use_bareme")
    ap.add_argument("--primes-avant-2017", action="store_true")
    ap.add_argument("--purge-usufruitier", action="store_true", dest="rachats_annuels_optimises")
    ap.add_argument("--png", default="capi_comparaison.png")
    ap.add_argument("--no-graph", action="store_true")
    a = ap.parse_args()

    p = Params(
        primes=a.primes, age_donateur=a.age_donateur, rendement=a.rendement,
        annees_don_deces=a.annees_don_deces, annees_deces_rachat=a.annees_deces_rachat,
        tmi=a.tmi, couple=not a.seul, use_bareme=a.use_bareme,
        primes_avant_2017=a.primes_avant_2017,
        rachats_annuels_optimises=a.rachats_annuels_optimises,
    )
    print(tableau_recap(p))
    if not a.no_graph:
        chemin = graphiques(p, a.png)
        if chemin:
            print(f"\n📊 Graphiques : {chemin}")


if __name__ == "__main__":
    main()
