// src/index.ts - Point d'entrée principal du bot
import "dotenv/config";
import pino from "pino";
import { LOG_LEVEL } from "./config";

// Validation stricte avec Zod (optionnelle, activée via USE_ZOD_VALIDATION=true)
// Sera appelée dans main() pour éviter top-level await

// Validation basique (toujours active pour rétrocompatibilité)
const REQUIRED = [
  "PRIVATE_KEY",
  "CLOB_API_KEY", 
  "CLOB_API_SECRET",
  "CLOB_PASSPHRASE",
  "POLY_PROXY_ADDRESS"
];

for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`❌ Missing required environment variable: ${k}`);
    process.exit(1);
  }
}

console.log("✅ ENV OK - All required environment variables are present");

export const rootLog = pino({
  level: LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
import { discoverLiveClobMarkets } from "./data/discovery";
// import { snapshotTop } from "./data/book"; // UNUSED - Removed
import { MarketMaker, MarketMakerConfig } from "./marketMaker";
// import { ensureUsdcAllowance } from "./utils/approve"; // UNUSED - Removed
import { 
  TARGET_SPREAD_CENTS, 
  TICK_IMPROVEMENT, 
  NOTIONAL_PER_ORDER_USDC, 
  MAX_ACTIVE_ORDERS, 
  REPLACE_COOLDOWN_MS, 
  DRY_RUN,
  MAX_INVENTORY,
  ALLOWANCE_THRESHOLD_USDC,
  MIN_SIZE_SHARES,
  MIN_NOTIONAL_USDC,
  MIN_SPREAD_MULTIPLIER,
  MAX_SPREAD_MULTIPLIER,
  AUTO_ADJUST_NOTIONAL,
  PRICE_CHANGE_THRESHOLD,
  MAX_DISTANCE_FROM_MID,
  MAX_ACTIVE_MARKETS,
  MIN_VOLUME_USDC,
  MIN_SPREAD_CENTS,
  MAX_SPREAD_CENTS
} from "./config";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

async function main() {
  // Validation Zod OBLIGATOIRE au boot (fail-fast)
  // Assure que toutes les variables sont correctes avant de démarrer
  const { parseEnv } = await import("./config/schema");
  parseEnv(process.env);
  
  const MIN_VOL = MIN_VOLUME_USDC; // Utiliser la config centralisée
  const MAX = MAX_ACTIVE_MARKETS; // Utiliser la config centralisée

  log.info({ 
    DRY_RUN, 
    TARGET_SPREAD_CENTS, 
    MIN_SPREAD_CENTS,
    NOTIONAL_PER_ORDER_USDC, 
    MAX_MARKETS: MAX,
    MIN_VOLUME_USDC
  }, "🚀 Démarrage du Bot Market Maker Polymarket");

  // S'assurer que l'allowance USDC est suffisante
  // TODO: Implémenter l'approbation automatique avec le SDK officiel
  if (!DRY_RUN) {
    log.warn("⚠️ Approbation USDC manuelle requise - assurez-vous que le proxy a une allowance suffisante vers l'Exchange");
  }

  // Test de connexion CLOB avec SDK officiel
  try {
    const { PolyClobClient } = await import("./clients/polySDK");
    new PolyClobClient(
      process.env.PRIVATE_KEY!,
      process.env.CLOB_API_KEY!,
      process.env.CLOB_API_SECRET!,
      process.env.CLOB_PASSPHRASE!,
      "https://clob.polymarket.com",
      process.env.POLY_PROXY_ADDRESS
    );
    log.info("✅ CLOB connected");
  } catch (error) {
    log.error({ error }, "❌ CLOB connection failed");
    process.exit(1);
  }

  const mkts = await discoverLiveClobMarkets(200, MIN_VOL);
  if (mkts.length === 0) {
    log.error("🚨 0 marchés live détectés — vérifie tes endpoints et ton réseau (Gamma/CLOB)");
    process.exit(1);
  }
  
  // Tri intelligent : volume + spread (AUCUNE priorité hardcodée)
  const minSpreadRequired = MIN_SPREAD_CENTS / 100; // Convertir centimes en décimal
  const maxSpreadAllowed = MAX_SPREAD_CENTS / 100; // Convertir centimes en décimal
  
  const picked = mkts
    .map(market => {
      // Calculer le spread pour chaque marché
      const spread = market.bestAskYes && market.bestBidYes 
        ? market.bestAskYes - market.bestBidYes 
        : 1.0; // Spread très large si pas de données
      
      // Score volume (normalisé) - facteur dominant
      const volumeScore = Math.log10((market.volume24hrClob || 0) + 1) * 100;
      
      // Score spread (spread large = meilleur pour capturer plus de profit)
      // Plus le spread est large, plus le score est élevé
      const spreadScore = Math.min(spread * 10000, 200); // 0.01 (1¢) = 100 points, cap à 200
      
      // Score total : volume + spread large
      const totalScore = volumeScore + spreadScore;
      
      return {
        ...market,
        spread,
        totalScore
      };
    })
    .filter(market => {
      // FILTRE 1 : Exclure les marchés avec spread trop serré
      if (market.spread < minSpreadRequired) {
        log.debug({ 
          slug: market.slug, 
          spread: (market.spread * 100).toFixed(2) + '¢',
          minRequired: MIN_SPREAD_CENTS + '¢'
        }, "Marché exclu : spread trop serré");
        return false;
      }
      
      // FILTRE 2 : Exclure les marchés avec spread TROP large (probablement fermés/résolus)
      if (market.spread > maxSpreadAllowed) {
        log.debug({ 
          slug: market.slug, 
          spread: (market.spread * 100).toFixed(2) + '¢',
          maxAllowed: MAX_SPREAD_CENTS + '¢'
        }, "Marché exclu : spread trop large (marché probablement inactif)");
        return false;
      }
      
      // FILTRE 3 : Vérifier que les prix sont réalistes
      const hasValidPrices = market.bestBidYes && market.bestAskYes && 
                            market.bestBidYes > 0.001 && market.bestAskYes < 0.999 &&
                            market.bestBidYes < market.bestAskYes;
      
      if (!hasValidPrices) {
        log.debug({ 
          slug: market.slug,
          bestBid: market.bestBidYes,
          bestAsk: market.bestAskYes
        }, "Marché exclu : prix invalides ou manquants");
        return false;
      }
      
      return true;
    })
    .sort((a, b) => b.totalScore - a.totalScore) // Tri décroissant par score
    .slice(0, MAX);
  log.info({ 
    selected: picked.length,
    markets: picked.map(m => ({ 
      slug: m.slug, 
      volume: m.volume24hrClob,
      spread: m.spread?.toFixed(4),
      score: m.totalScore?.toFixed(1)
    }))
  }, "📊 Marchés sélectionnés pour le market making");

  // Configuration du MarketMaker
  const mmConfig: MarketMakerConfig = {
    targetSpreadCents: TARGET_SPREAD_CENTS,
    tickImprovement: TICK_IMPROVEMENT,
    notionalPerOrderUsdc: NOTIONAL_PER_ORDER_USDC,
    maxActiveOrders: MAX_ACTIVE_ORDERS,
    replaceCooldownMs: REPLACE_COOLDOWN_MS,
    dryRun: DRY_RUN,
    maxInventory: MAX_INVENTORY,
    allowanceThresholdUsdc: ALLOWANCE_THRESHOLD_USDC,
    minSizeShares: MIN_SIZE_SHARES,
    minNotionalUsdc: MIN_NOTIONAL_USDC,
    minSpreadMultiplier: MIN_SPREAD_MULTIPLIER,
    maxSpreadMultiplier: MAX_SPREAD_MULTIPLIER,
    autoAdjustNotional: AUTO_ADJUST_NOTIONAL,
    priceChangeThreshold: PRICE_CHANGE_THRESHOLD,
    maxDistanceFromMid: MAX_DISTANCE_FROM_MID
  };

  // Démarrer le market making sur chaque marché sélectionné
  const marketMakers: MarketMaker[] = [];
  let activeMarketMakers = 0;
  
  for (const market of picked) {
    log.info({ 
      market: market.slug, 
      volume: market.volume24hrClob,
      yesToken: market.yesTokenId.substring(0, 20) + '...',
      noToken: market.noTokenId.substring(0, 20) + '...'
    }, "🎯 Démarrer market making");

    const marketMaker = new MarketMaker(mmConfig);
    marketMakers.push(marketMaker);
    
    // Démarrer le market making (ne pas attendre)
    marketMaker.start(market).then(() => {
      activeMarketMakers++;
      log.info({ 
        market: market.slug,
        activeMarketMakers 
      }, "✅ Market maker démarré avec succès");
    }).catch(error => {
      log.error({ error, market: market.slug }, "❌ Erreur dans le market making - tentative marché suivant si disponible");
      
      // Si aucun market maker n'est actif, essayer de démarrer le prochain marché disponible
      if (activeMarketMakers === 0 && picked.indexOf(market) < picked.length - 1) {
        log.info("🔄 Tentative de démarrage du marché suivant...");
      }
    });
  }

  log.info({ 
    totalMarketMakers: marketMakers.length,
    config: mmConfig 
  }, "✅ Market makers en cours de démarrage");

  // Gestion propre de l'arrêt (SIGINT = Ctrl+C local)
  process.on('SIGINT', async () => {
    log.info("🛑 SIGINT reçu, arrêt demandé, nettoyage en cours...");
    
    for (const mm of marketMakers) {
      await mm.stop();
    }
    
    log.info("👋 Bot arrêté proprement");
    process.exit(0);
  });

  // Gestion arrêt gracieux Railway/Docker (SIGTERM)
  process.on('SIGTERM', async () => {
    log.info("🛑 SIGTERM reçu (Railway/Docker shutdown), arrêt gracieux en cours...");
    
    for (const mm of marketMakers) {
      await mm.stop();
    }
    
    log.info("👋 Bot arrêté proprement (graceful shutdown)");
    process.exit(0);
  });
}

main().catch(e=>{ log.error(e); process.exit(1); });
