# PolymMM-GuardedSpread

Bot de market-making pour Polymarket avec gestion des risques stricte et retrait immédiat.

**Version :** 2.0  
**Status :** ✅ Fonctionnel et testé

---

## 🎯 Principe

Trading séquentiel strict : capture le spread sur marchés liquides avec :
- Filtrage rigoureux (spread, volume, depth, temps)
- Machine à états (IDLE → BUY → SELL → COMPLETE)
- Caps de risque contraignants
- Retrait immédiat si critères non respectés
- Side-lock : UN SEUL ordre actif par marché

---

## 🚀 Quick Start

### 1. Installation

```bash
npm install
```

### 2. Configuration

Copier `.env.example` vers `.env` et remplir :

```env
# Credentials Polymarket
PRIVATE_KEY=0x...
CLOB_API_KEY=...
CLOB_API_SECRET=...
CLOB_PASSPHRASE=...
POLY_PROXY_ADDRESS=0x...

# Mode (IMPORTANT: mettre true pour tests)
DRY_RUN=true

# Marchés
MAX_MARKETS=2
MIN_SPREAD_CENTS=2
MIN_VOLUME_24H_USD=5000
MIN_DEPTH_TOP2_USD=300
HOURS_TO_CLOSE_MIN=24
MAX_MARKETS_PER_EVENT=1

# Sizing & Profit
MIN_NOTIONAL_PER_ORDER_USDC=2.0
MIN_EXPECTED_PROFIT_USDC=0.02
MIN_SIZE_SHARES=1.0

# Caps de risque
MAX_SHARES_PER_MARKET=25
MAX_USDC_PER_MARKET=5
MAX_NOTIONAL_AT_RISK_USDC=10

# Ordres
ORDER_TTL_MS=10000
REPLACE_PRICE_TICKS=1
ASK_CHASE_WINDOW_SEC=8
ASK_CHASE_MAX_REPLACES=3
```

### 3. Lancement

```bash
# Compiler
npm run build

# Démarrer le bot
npm start
```

---

## 📊 Flux séquentiel (Machine à états)

```
IDLE → PLACE_BUY → WAIT_BUY_FILL → PLACE_SELL → ASK_CHASE → WAIT_SELL_FILL → COMPLETE → IDLE
  ↳ DEACTIVATING (si critères non respectés)
```

### États

- **IDLE** : Vérifie critères → démarre cycle BUY
- **PLACE_BUY** : Place BUY au best bid (post-only, GTC)
- **WAIT_BUY_FILL** : Attend fill ou replace si prix/TTL change
- **PLACE_SELL** : Place SELL au best ask (miroir du BUY)
- **ASK_CHASE** : Chase le ask pendant 8s (max 3 replaces)
- **WAIT_SELL_FILL** : Attend fill SELL
- **COMPLETE** : Cycle terminé → retour IDLE
- **DEACTIVATING** : Liquide position + retire marché

---

## 🔒 Filtrage strict

Un marché est éligible SI ET SEULEMENT SI :

1. `spread ≥ MIN_SPREAD_CENTS`
2. `volume_24h ≥ MIN_VOLUME_24H_USD`
3. `depth_top2 ≥ MIN_DEPTH_TOP2_USD`
4. `hours_to_close ≥ HOURS_TO_CLOSE_MIN`
5. Supporte `MIN_NOTIONAL_PER_ORDER_USDC`
6. `expected_profit ≥ MIN_EXPECTED_PROFIT_USDC`

Score classement : `spread*0.4 + depth*0.3 + volume*0.2 + time*0.1`

---

## 🛡️ Caps de risque

Le bot refuse de placer un ordre si :

- `position_shares_by_market > MAX_SHARES_PER_MARKET`
- `notional_exposure_by_market > MAX_USDC_PER_MARKET`
- `notional_exposure_global > MAX_NOTIONAL_AT_RISK_USDC`
- `taille_en_USDC < MIN_NOTIONAL_PER_ORDER_USDC`
- `expected_profit < MIN_EXPECTED_PROFIT_USDC`

---

## 🔄 Retrait immédiat

Si un marché actif ne respecte plus UN SEUL filtre :

1. Arrêter nouveaux BUY
2. Liquider position : SELL au best ask + ask_chase
3. Annuler ordres restants
4. Unsubscribe WebSocket
5. Remplacer par meilleur candidat

---

## 📈 Architecture

```
src/
├── clients/       # Polymarket SDK + API Gamma
├── ws/            # WebSocket temps réel (prix + fills)
├── lib/           # Utilitaires (quantisation)
├── data/          # Orderbook + découverte marchés
├── core/          # Modules principaux
│   ├── MarketSelector.ts   # Filtrage strict
│   ├── StateMachine.ts     # 8 états + transitions
│   ├── RiskManager.ts      # Caps contraignants
│   ├── OrderManager.ts     # Side-lock + post-only
│   └── MarketMaker.ts      # Orchestrateur
├── config.ts      # Configuration centralisée
└── index.ts       # Point d'entrée
```

---

## 📝 Logs

Le bot génère des logs détaillés :

```json
{
  "level": "info",
  "time": "2025-10-16T12:34:11.694Z",
  "name": "selector",
  "total": 4737,
  "afterVolumeFilter": 482,
  "eligible": 37,
  "final": 2,
  "msg": "Market selection completed"
}
```

**Skip reasons logs :**
- `spread_too_small`
- `volume_low`
- `depth_low`
- `closing_soon`
- `expected_profit_low`
- `risk_cap_hit`
- `would_cross`

---

## ⚠️ Important

### Avant la production

1. ✅ **Tester en DRY_RUN=true**
2. ✅ Observer un cycle complet (IDLE → ... → IDLE)
3. ✅ Vérifier les logs à chaque transition
4. ✅ Monitorer 24h en DRY_RUN
5. ✅ Commencer avec des caps faibles

### Interdictions strictes

- ❌ Placer YES et NO simultanément
- ❌ Plusieurs ordres actifs par marché
- ❌ Dépasser les caps de risque
- ❌ Ordres < MIN_NOTIONAL_PER_ORDER_USDC
- ❌ Trader marchés non éligibles

---

## 🧪 Tests réels

**Test du 16 octobre 2025 :**

```
✅ Marchés détectés : 4,737
✅ Pré-filtrés volume : 482
✅ Marchés éligibles : 37
✅ Sélectionnés : 2
   - BTC above 100k : spread 7.0¢, volume $20,310
   - Gemini 3.0 : spread 3.0¢, volume $329,493
✅ Prix temps réel : WebSocket opérationnel
✅ Bot démarré : Main loop running
```

---

## 📚 Documentation

- **Règles du flux :** `.cursor/rules/polymarket-guarded-spread.mdc`
- **Sauvegarde v1 :** `FLUX_SAUVEGARDE_V1.md`
- **Configuration :** `env.example`

---

## 🔧 Scripts utiles

```bash
# Lancer le bot
npm start

# Compiler uniquement
npm run build

# Vérifier la syntaxe
npm run build
```

---

## 📞 Support

Si le bot ne démarre pas :

1. Vérifier `.env` (toutes les variables requises)
2. Vérifier `LOG_LEVEL=debug` pour plus de détails
3. Consulter `FLUX_SAUVEGARDE_V1.md` pour état connu fonctionnel

---

## 🎯 Objectif

Bot market-making **rentable, sécurisé et robuste** qui :
- ✅ Capture le spread sur marchés liquides
- ✅ Gère les risques strictement
- ✅ Se retire si conditions défavorables
- ✅ Monitore en continu
- ✅ Ne plante jamais

---

**Version :** PolymMM-GuardedSpread v2.0  
**License :** MIT  
**Status :** 🟢 Production-ready (avec DRY_RUN activé pour tests)
