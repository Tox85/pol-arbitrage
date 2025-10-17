// Configuration centralisée pour PolymMM-GuardedSpread
// ============================================================
// ADDRESSES & INFRASTRUCTURE
// ============================================================
export const EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC sur Polygon
export const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
export const POLY_PROXY_ADDRESS = process.env.POLY_PROXY_ADDRESS || "";
export const WSS_URL = process.env.WSS_URL || "wss://ws-subscriptions-clob.polymarket.com/ws/market";
export const WSS_USER_URL = process.env.WSS_USER_URL || "wss://ws-subscriptions-clob.polymarket.com/ws/user";

// ============================================================
// LOGGING
// ============================================================
export const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// ============================================================
// MARKET SELECTION - Filtrage strict
// ============================================================
export const MAX_MARKETS = Number(process.env.MAX_MARKETS) || 3;
export const MIN_SPREAD_CENTS = Number(process.env.MIN_SPREAD_CENTS) || 1.5;
export const MIN_VOLUME_24H_USD = Number(process.env.MIN_VOLUME_24H_USD) || 1000; // Réduit pour plus de candidats
export const MIN_DEPTH_TOP2_USD = Number(process.env.MIN_DEPTH_TOP2_USD) || 300;
export const HOURS_TO_CLOSE_MIN = Number(process.env.HOURS_TO_CLOSE_MIN) || 24;
export const MAX_MARKETS_PER_EVENT = Number(process.env.MAX_MARKETS_PER_EVENT) || 1;

// ============================================================
// ORDER SIZING - Notional & expected profit
// ============================================================
export const MIN_NOTIONAL_PER_ORDER_USDC = Number(process.env.MIN_NOTIONAL_PER_ORDER_USDC) || 2.0;
export const MIN_EXPECTED_PROFIT_USDC = Number(process.env.MIN_EXPECTED_PROFIT_USDC) || 0.02;

// ============================================================
// RISK CAPS - Exposition & inventory
// ============================================================
export const MAX_SHARES_PER_MARKET = Number(process.env.MAX_SHARES_PER_MARKET) || 50;
export const MAX_USDC_PER_MARKET = Number(process.env.MAX_USDC_PER_MARKET) || 8;
export const MAX_NOTIONAL_AT_RISK_USDC = Number(process.env.MAX_NOTIONAL_AT_RISK_USDC) || 25;

// ============================================================
// ORDER MANAGEMENT - TTL, Replace, Ask Chase
// ============================================================
export const ORDER_TTL_MS = Number(process.env.ORDER_TTL_MS) || 10000; // 10s
export const REPLACE_PRICE_TICKS = Number(process.env.REPLACE_PRICE_TICKS) || 1; // 1 tick pour replace
export const ASK_CHASE_WINDOW_SEC = Number(process.env.ASK_CHASE_WINDOW_SEC) || 8; // 8s pour chase
export const ASK_CHASE_MAX_REPLACES = Number(process.env.ASK_CHASE_MAX_REPLACES) || 3; // Max 3 replaces

// ============================================================
// INTERNAL CONSTANTS
// ============================================================
export const DECIMALS = 1_000_000n; // USDC & CTF = 6 décimales
export const DEFAULT_TICK_SIZE = 0.01; // Fallback (la vraie valeur vient de /book et tick_size_change)
export const MIN_SIZE_SHARES = parseFloat(process.env.MIN_SIZE_SHARES || "1.0"); // Minimum shares par ordre

// ============================================================
// DRY RUN MODE
// ============================================================
export const DRY_RUN = process.env.DRY_RUN === "true";

// ============================================================
// MONITORING & RECONCILIATION
// ============================================================
export const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS) || 60000; // 60s
export const METRICS_LOG_INTERVAL_MS = Number(process.env.METRICS_LOG_INTERVAL_MS) || 60000; // 60s
