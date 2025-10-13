// Configuration centralisée pour Polymarket
// Exchange (Polygon) - CTFExchange verifyingContract
export const EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC sur Polygon
// CHAIN_ID = 137 - REMOVED (unused)
export const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
export const POLY_PROXY_ADDRESS = process.env.POLY_PROXY_ADDRESS || "";
export const WSS_URL = process.env.WSS_URL || "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// Configuration des logs
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// Configuration du market making
export const DECIMALS = 1_000_000n; // USDC & CTF = 6 décimales sur Polymarket
export const PLACE_EVERY_MS = 1500; // Anti-spam pour les logs

// Configuration du bot (depuis .env)
export const TARGET_SPREAD_CENTS = Number(process.env.TARGET_SPREAD_CENTS) || 3; // Augmenté à 3¢ pour rentabilité
export const TICK_IMPROVEMENT = Number(process.env.TICK_IMPROVEMENT) || 1; // 1 tick = 0.1¢ d'amélioration (priorité de file)
export const NOTIONAL_PER_ORDER_USDC = Number(process.env.NOTIONAL_PER_ORDER_USDC) || 1.5; // Réduit à 1.5$ pour économiser le capital
export const MAX_ACTIVE_ORDERS = Number(process.env.MAX_ACTIVE_ORDERS) || 100;
export const REPLACE_COOLDOWN_MS = Number(process.env.REPLACE_COOLDOWN_MS) || 500; // Repricing agressif pour capturer spread
export const ORDER_TTL_MS = Number(process.env.ORDER_TTL_MS) || 30000;
export const PRICE_CHANGE_THRESHOLD = Number(process.env.PRICE_CHANGE_THRESHOLD) || 0.001;
export const PROXY_ADDRESS = process.env.POLY_PROXY_ADDRESS!;
export const DRY_RUN = process.env.DRY_RUN === "true";

// Configuration de l'inventaire
export const MAX_INVENTORY = Number(process.env.MAX_INVENTORY) || 100; // Maximum shares par token
export const MIN_INVENTORY_CLEANUP = Number(process.env.MIN_INVENTORY_CLEANUP) || 0.01; // Seuil de nettoyage

// Configuration des allowances
export const ALLOWANCE_THRESHOLD_USDC = Number(process.env.ALLOWANCE_THRESHOLD_USDC) || 100; // Seuil minimum USDC
export const ALLOWANCE_CHECK_COOLDOWN_MS = Number(process.env.ALLOWANCE_CHECK_COOLDOWN_MS) || 30000; // 30 secondes

// Configuration du spread dynamique
// SPREAD_MULTIPLIER_LOW/HIGH - REMOVED (duplicates, using MIN/MAX instead)
export const MIN_SPREAD_MULTIPLIER = Number(process.env.SPREAD_MULTIPLIER_LOW) || 0.5; // Multiplicateur pour spread serré
export const MAX_SPREAD_MULTIPLIER = Number(process.env.SPREAD_MULTIPLIER_HIGH) || 2.0; // Multiplicateur pour spread large

// Configuration de la stratégie de parité
export const PARITY_THRESHOLD = Number(process.env.PARITY_THRESHOLD) || 0.005; // Écart maximum Yes+No vs 1 pour déclencher l'arbitrage

// Configuration des tailles
export const MIN_SIZE_SHARES = Number(process.env.MIN_SIZE_SHARES) || 5; // Taille minimum en shares
export const MIN_NOTIONAL_USDC = Number(process.env.MIN_NOTIONAL_USDC) || 1.0; // Notional minimum en USDC
export const MIN_NOTIONAL_SELL_USDC = Number(process.env.MIN_NOTIONAL_SELL_USDC) || 1.0; // Notional minimum pour les SELL
export const MAX_SELL_PER_ORDER_SHARES = Number(process.env.MAX_SELL_PER_ORDER_SHARES) || 50; // Maximum shares par ordre SELL

// Configuration de l'inventaire par token
export const MAX_INVENTORY_YES = Number(process.env.MAX_INVENTORY_YES) || 500; // Inventaire maximum pour YES
export const MAX_INVENTORY_NO = Number(process.env.MAX_INVENTORY_NO) || 500; // Inventaire maximum pour NO

// Configuration de la persistance
export const INVENTORY_PERSISTENCE_FILE = process.env.INVENTORY_PERSISTENCE_FILE || '.inventory.json'; // Fichier de persistance

// Configuration du notional adaptatif
export const AUTO_ADJUST_NOTIONAL = process.env.AUTO_ADJUST_NOTIONAL === 'true'; // Ajustement automatique du notional selon le solde

// Configuration de la réactivité aux mouvements de prix
// PRICE_CHANGE_THRESHOLD déjà déclaré plus haut
export const MAX_DISTANCE_FROM_MID = Number(process.env.MAX_DISTANCE_FROM_MID) || 0.05; // 5¢ - distance max du mid-price
export const MAX_ACTIVE_MARKETS = Number(process.env.MAX_ACTIVE_MARKETS) || 2; // Nombre maximum de marchés actifs (2 pour avoir un fallback)
export const MIN_VOLUME_USDC = Number(process.env.MIN_VOLUME_USDC) || 5000; // Volume minimum 24h en USDC
export const MIN_SPREAD_CENTS = Number(process.env.MIN_SPREAD_CENTS) || 0.1; // Spread minimum requis en centimes (0.1¢ = très serré, 0.5¢ = large)
export const MAX_SPREAD_CENTS = Number(process.env.MAX_SPREAD_CENTS) || 10; // Spread maximum accepté en centimes (10¢ = large mais réaliste)

// Configuration du capital à risque
export const MAX_NOTIONAL_AT_RISK_USDC = Number(process.env.MAX_NOTIONAL_AT_RISK_USDC) || 15.0; // Capital max exposé
export const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS) || 60000; // 60s - intervalle de réconciliation

// Configuration PnL et métriques
export const PNL_PERSISTENCE_FILE = process.env.PNL_PERSISTENCE_FILE || '.pnl.json'; // Fichier de persistance PnL
export const METRICS_LOG_INTERVAL_MS = Number(process.env.METRICS_LOG_INTERVAL_MS) || 60000; // 60s - intervalle de log métriques

// Configuration WebSocket utilisateur
export const WSS_USER_URL = process.env.WSS_USER_URL || "wss://ws-subscriptions-clob.polymarket.com/ws/user"; // WebSocket fills

// Configuration du skew d'inventaire
export const INVENTORY_SKEW_LAMBDA = Number(process.env.INVENTORY_SKEW_LAMBDA) || 0.002; // 0.2% par 100 shares
